/**
 * 导出：把扫描到的插件连依赖打成 zip 整合包。
 *
 * 包内布局：
 *   manifest.json
 *   README.txt
 *   packages/<插件名>/...                  插件本体
 *   packages/<插件名>/node_modules/<依赖>/  扁平化的运行时依赖
 *   data/<插件名>/<目录>/...                可选：插件数据
 *
 * @module dsh-plugin-pack/export
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanProfile } from './scan.js';
import { writeZipStream } from './zip-stream.js';
import { writeTgzStream } from './tar.js';
import { dshHome as resolveDshHome, profileDir as resolveProfileDir, profileName as resolveProfileName, packSegment, stamp, humanBytes } from './home.js';
import { walkTree, walkTreeAsync, SKIP_DIRS, fileFilter, ensureDir, removeTree } from './util.js';

/** 新整合包格式：内部每个插件是一个 .tgz。 */
export const PACK_FORMAT_V2 = 'dsh-plugin-pack@2';
/** 旧格式：内部是散文件。 */
export const PACK_FORMAT_V1 = 'dsh-plugin-pack@1';
/** 写出的格式用 v2；导入端同时认 v1 和 v2。 */
export const PACK_FORMAT = PACK_FORMAT_V2;
export const GENERATOR = { name: 'dsh-plugin-pack', version: '1.0.0' };

/**
 * 生成整合包。
 *
 * @param {object} [options]
 * @param {string} [options.out] 输出文件；目录则自动命名
 * @param {string[]|null} [options.include]
 * @param {string[]} [options.exclude]
 * @param {boolean} [options.includeData]
 * @param {boolean} [options.includeSecrets]
 * @param {number} [options.maxBytes]
 * @param {boolean} [options.dryRun]
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<object>} 导出报告
 */
export async function exportBundle(options = {}) {
  const env = options.env ?? process.env;
  const home = options.dshHome ? path.resolve(options.dshHome) : resolveDshHome(env);
  const profile = options.profileDir ? path.resolve(options.profileDir) : resolveProfileDir(env);
  const profileLabel = options.profileName ?? resolveProfileName(env);
  const includeSecrets = Boolean(options.includeSecrets);
  // maxBytes：显式传 0 = 不限制；没传才用默认值。
  //
  // 注意这个上限是按**未压缩**字节算的（写入时才知道真实压缩比），
  // 而典型压缩比约 1:3 —— 实测 479 MiB 原始内容产出 166 MiB 的 zip。
  // 所以默认给 2 GiB 原始体积（约 600~700 MiB 成品），
  // 默认 512 MiB 会把正常的全量备份直接挡掉。
  const maxBytes =
    options.maxBytes === 0
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? Math.floor(options.maxBytes)
        : 2 * 1024 * 1024 * 1024;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const warnings = [];

  const scan = await scanProfile({
    env,
    dshHome: home,
    profileDir: profile,
    profileName: profileLabel,
    include: options.include ?? null,
    exclude: options.exclude ?? [],
    includeData: Boolean(options.includeData),
    includeSecrets,
    maxBytes,
    // 导出要精确体积，不能用可能过期的缓存
    fresh: true,
  });
  warnings.push(...scan.warnings);

  const selected = scan.selected;
  if (!selected.length) {
    const error = new Error('没有可导出的插件：当前 profile 里没扫到第三方插件，或者 include/exclude 把它们全过滤掉了');
    error.code = 'NO_PLUGINS';
    throw error;
  }

  const createdAt = new Date();
  const stampText = stamp(createdAt);
  const manifest = {
    format: PACK_FORMAT,
    createdAt: createdAt.toISOString(),
    generator: GENERATOR,
    // v2：packages/ 下每个插件是一个独立 .tgz
    layout: 'tarballs',
    source: {
      profile: profileLabel,
      profileDir: profile,
      dshHome: home,
      dshVersion: readDshVersion(home),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    },
    plugins: selected.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      // 打包完成后会回填成 packages/<包名>-<版本>.tgz
      tgz: null,
      description: plugin.description,
      kind: plugin.kind,
      sources: plugin.sources,
      declaredName: plugin.declaredName,
      link: plugin.link,
      inBundles: plugin.inBundles,
      bundleIndex: plugin.bundleIndex,
      hasPatch: plugin.hasPatch,
      patchRel: plugin.patchRel,
      client: plugin.client,
      entry: plugin.entry,
      deps: plugin.deps.map((dep) => ({ name: dep.name, version: dep.version, bytes: dep.bytes })),
      patchRows: plugin.patchRows,
      insertRows: plugin.insertRows,
      dataDirs: plugin.dataDirs.map((data) => ({ name: data.name, bytes: data.bytes, files: data.files })),
      bytes: plugin.bytes,
      fileCount: plugin.fileCount,
      warnings: plugin.warnings,
    })),
    profile: {
      bundles: scan.profile.bundles,
      dependencies: scan.profile.dependencies,
    },
    warnings,
  };

  /** @type {Array<{name: string, file?: string, data?: Buffer|string}>} */
  const entries = [];
  let planned = 0;
  const report = [];

  /**
   * 把一个插件打成 npm tarball 的 Buffer（异步）。
   *
   * 单个插件导出直接用这个结果；整合包则把它当成 zip 里的一个条目。
   * 两者共用同一段逻辑，保证"单导出的 tgz"和"整合包里的 tgz"完全一致。
   *
   * @param {object} plugin scan 结果里的一个插件
   * @returns {Promise<{ buffer: Buffer, bytes: number, files: number, deps: number, tgzName: string }>}
   */
  const buildPluginTarball = async (plugin) => {
    const keepFile = fileFilter({ includeSecrets });
    const skipDirs = new Set([...SKIP_DIRS, 'node_modules']);
    /** @type {Array<{name: string}>} */
    const tgzEntries = [];

    const addToTgz = async (prefix, root) => {
      let files = 0;
      let bytes = 0;
      for await (const item of walkTreeAsync(root, { skipDirs, keepFile })) {
        planned += item.size;
        if (planned > maxBytes) {
          const error = new Error(
            `整合包超过体积上限 ${humanBytes(maxBytes)}（已到 ${humanBytes(planned)}）。` +
              `在导出页把「体积上限」调大、点「按当前选择自动调大」，或改成「不限制」；也可以只勾选部分插件。`,
          );
          error.code = 'TOO_LARGE';
          throw error;
        }
        // npm tarball 的路径一律在 package/ 下
        tgzEntries.push({ name: `package/${prefix ? `${prefix}/` : ''}${item.rel}`, file: item.path });
        files += 1;
        bytes += item.size;
      }
      return { files, bytes };
    };

    const main = await addToTgz('', plugin.dir);
    for (const dep of plugin.deps) {
      // 依赖目录必须用**真实包名结构**：@electron/get 要落成 node_modules/@electron/get/，
      // 不能压成 @electron__get —— 那样 Node 的模块解析找不到它（ERR_MODULE_NOT_FOUND）。
      // packSegment 只适合做"单层目录名"（如 local-plugins 下的插件目录），不能用在 node_modules。
      await addToTgz(`node_modules/${dep.name}`, dep.dir);
    }

    // 写进临时文件再读回 —— writeTgzStream 是写盘接口，这里借一次
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-pack-tgz-'));
    const tmpFile = path.join(tmpDir, 'plugin.tgz');
    try {
      const result = await writeTgzStream(tgzEntries, tmpFile, { maxBytes: maxBytes * 4 });
      const buffer = await fs.promises.readFile(tmpFile);
      return {
        buffer,
        bytes: result.bytes,
        files: main.files,
        deps: plugin.deps.length,
        tgzName: `${packSegment(plugin.name)}-${plugin.version}.tgz`,
      };
    } finally {
      removeTree(tmpDir);
    }
  };

  for (let index = 0; index < selected.length; index += 1) {
    const plugin = selected[index];
    const pluginSegment = packSegment(plugin.name);
    const tarball = await buildPluginTarball(plugin);
    onProgress(`已打包 ${plugin.name} → ${tarball.tgzName}（${humanBytes(tarball.bytes)}）`);

    // 整合包内每个插件是一个独立的 .tgz，放在 packages/ 下
    const tgzPath = `packages/${tarball.tgzName}`;
    entries.push({ name: tgzPath, data: tarball.buffer });
    // 回填 manifest 里的路径，导入端据此定位
    manifest.plugins[index].tgz = tgzPath;
    manifest.plugins[index].tgzBytes = tarball.bytes;

    for (const data of plugin.dataDirs) {
      const keepFile = fileFilter({ includeSecrets });
      const skipDirs = new Set([...SKIP_DIRS, 'node_modules']);
      for await (const item of walkTreeAsync(data.path, { skipDirs, keepFile })) {
        planned += item.size;
        if (planned > maxBytes) {
          const error = new Error(`整合包超过体积上限 ${humanBytes(maxBytes)}（已到 ${humanBytes(planned)}）。`);
          error.code = 'TOO_LARGE';
          throw error;
        }
        entries.push({ name: `data/${pluginSegment}/${packSegment(data.name)}/${item.rel}`, file: item.path });
      }
    }

    report.push({
      name: plugin.name,
      version: plugin.version,
      kind: plugin.kind,
      files: tarball.files,
      bytes: tarball.bytes,
      deps: tarball.deps,
      patchRows: plugin.patchRows.length,
      insertRows: plugin.insertRows.length,
      dataDirs: plugin.dataDirs.length,
      tgz: `packages/${tarball.tgzName}`,
    });

    // 单个插件导出：直接把这个 tarball 当成品
    if (selected.length === 1) {
      const outFile = resolveOutFile(options.out, home, profileLabel, stampText, {
        kind: 'plugin',
        pluginName: plugin.name,
      });
      if (options.dryRun) {
        return {
          ok: true,
          dryRun: true,
          kind: 'plugin',
          file: outFile,
          bytes: tarball.bytes,
          entries: tarball.files,
          plugins: report,
          warnings,
          manifest,
        };
      }
      ensureDir(path.dirname(outFile));
      await fs.promises.writeFile(outFile, tarball.buffer);
      onProgress(`已写出 ${outFile}（${humanBytes(tarball.bytes)}）`);
      return {
        ok: true,
        kind: 'plugin',
        file: outFile,
        bytes: tarball.bytes,
        rawBytes: planned,
        entries: tarball.files,
        plugins: report,
        warnings,
        manifest,
      };
    }
  }

  /* 走到这里一定是多个插件 → 整合包（.zip）。
   * 单个插件已在上面循环里直接返回 .tgz 了。
   *
   * 整合包里的每个插件是一个独立的 .tgz（packages/<包名>-<版本>.tgz），
   * 这样：
   *   - 包内结构对人是可读的（一眼看出有哪些插件、各自多大）
   *   - 导入时可以只解自己要的那几个
   *   - 单个 tgz 抽出来就能直接 npm i，与单独导出的文件完全等价
   */
  const outFile = resolveOutFile(options.out, home, profileLabel, stampText, { kind: 'bundle' });

  const readme = renderReadme(manifest, report, createdAt);
  const head = [
    { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'README.txt', data: readme },
  ];

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      kind: 'bundle',
      file: outFile,
      bytes: head.reduce((sum, entry) => sum + Buffer.byteLength(entry.data), 0) + planned,
      entries: entries.length + head.length,
      plugins: report,
      warnings,
      manifest,
    };
  }

  ensureDir(path.dirname(outFile));

  let progressBytes = 0;
  const result = await writeZipStream([...head, ...entries], outFile, {
    maxBytes: maxBytes * 4, // 压缩前的原始总量上限
    onEntry: (name, bytes) => {
      progressBytes += bytes;
      if (progressBytes > 0 && progressBytes % (32 * 1024 * 1024) < bytes) {
        onProgress(`已写入 ${humanBytes(progressBytes)} / ${humanBytes(planned)}`);
      }
    },
  });
  onProgress(`已写出 ${outFile}（${humanBytes(result.bytes)}）`);

  return {
    ok: true,
    kind: 'bundle',
    file: outFile,
    bytes: result.bytes,
    rawBytes: planned,
    entries: result.entries,
    plugins: report,
    warnings,
    manifest,
  };
}

/**
 * 解析输出路径；传目录时自动生成文件名。
 *
 * 三条规则按顺序：
 *   1. 空 → $DSH_HOME/exports/<默认名>
 *   2. 是已存在的目录，或字符串以分隔符结尾 → 当成目录，拼默认文件名
 *   3. 已带正确扩展名 → 原样；否则补扩展名
 *
 * 扩展名跟着导出类型走：
 *   - 单个插件 → .tgz（npm tarball，包名化文件名）
 *   - 多个插件 → .zip（整合包）
 *
 * @param {string} raw
 * @param {string} home
 * @param {string} profileLabel
 * @param {string} stampText
 * @param {{ kind?: 'plugin'|'bundle', pluginName?: string }} [options]
 */
export function resolveOutFile(raw, home, profileLabel, stampText, options = {}) {
  const kind = options.kind === 'plugin' ? 'plugin' : 'bundle';
  const ext = kind === 'plugin' ? '.tgz' : '.zip';
  const fallbackName =
    kind === 'plugin'
      ? // npm tarball 惯例用「包名-版本」或「包名-时间戳」，这里用包名 + 时间戳便于区分
        `${slugForFile(options.pluginName ?? 'plugin')}-${stampText}.tgz`
      : `dsh-plugin-pack-${profileLabel}-${stampText}.zip`;

  if (!raw || !String(raw).trim()) {
    return path.join(home, 'exports', fallbackName);
  }
  const text = String(raw).trim();
  const target = path.resolve(text);
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) return path.join(target, fallbackName);
  // 末尾带分隔符：用户明确指了"这个目录"，即使它还不存在。
  // 但 `xxx.tgz\` 这种是误操作（把文件当目录）——
  // 去掉分隔符后如果像个带扩展名的文件名，就按文件处理，别再拼一层。
  if (/[\\/]$/.test(text)) {
    const trimmed = text.replace(/[\\/]+$/, '');
    if (/\.[a-z0-9]{2,8}$/i.test(path.basename(trimmed))) {
      return path.resolve(trimmed);
    }
    return path.join(target, fallbackName);
  }
  if (stat?.isFile()) return target;
  // 已经带了本类型该有的扩展名就原样；否则补上
  if (target.toLowerCase().endsWith(ext)) return target;
  // 用户明确写成了另一种扩展名（比如单插件却写了 .zip）→ 尊重用户选择
  if (kind === 'plugin' && target.toLowerCase().endsWith('.zip')) return target;
  if (kind === 'bundle' && target.toLowerCase().endsWith('.tgz')) return target;
  return `${target}${ext}`;
}

/** 文件名里安全的包名（scoped 包把 / 换成 --）。 */
function slugForFile(name) {
  return (
    String(name ?? '')
      .replace(/^@/, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'plugin'
  );
}

/** 读 dsh 版本（有就读，没有就空）。 */
function readDshVersion(home) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(home, 'version.json'), 'utf8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/** 包内 README。 */
function renderReadme(manifest, report, createdAt) {
  const lines = [
    'dsh-plugin-pack 整合包（v2 布局）',
    '===============================',
    '',
    `生成时间: ${createdAt.toISOString()}`,
    `来源 profile: ${manifest.source.profile}`,
    `来源目录: ${manifest.source.profileDir}`,
    `插件数量: ${report.length}`,
    '',
    '包内结构:',
    '  manifest.json            插件清单与配置',
    '  packages/<包名>-<版本>.tgz  每个插件一个 npm tarball',
    '  data/...                 可选，插件数据目录',
    '',
    '每个 .tgz 都是标准的 npm 包（package/ 前缀），可以单独取出来用：',
    '  npm i ./packages/<包名>-<版本>.tgz',
    '',
    '插件清单:',
    ...report.map(
      (item) =>
        `  - ${item.name}@${item.version}  ${humanBytes(item.bytes)} / 依赖 ${item.deps} 个${item.tgz ? `  → ${item.tgz}` : ''}`,
    ),
    '',
    '导入方式（任选一种）:',
    '  1. dsh 里拖进「插件 → 导入」的框',
    '  2. 命令行:      dsh-plugin-pack import <这个 zip 的路径>',
    '  3. 让 agent 调用: plugin_pack_import({ file: "<路径>" })',
    '',
    '整包和单个 .tgz 都能导入：拖 zip 是装整批，拖 tgz 是只装那一个。',
    '导入会先把 package.json 和 cordis.patch.yml 备份到 profile 的 .plugin-backups/ 下，',
    '然后把插件落到 local-plugins/ 并写回 profile 配置。导入完成后重启 dsh 生效。',
    '',
  ];
  return `${lines.join('\n')}\n`;
}
