/**
 * 导入：解整合包 → 备份 → 落到 local-plugins → 合并 profile 配置 → 建链接。
 *
 * 设计原则：
 * - 任何写操作之前先备份 package.json / cordis.patch.yml / 被覆盖的插件目录；
 * - 所有 zip 条目路径都过 safeJoin，不允许穿出目标目录；
 * - dryRun 只返回计划，一个字节都不写。
 *
 * @module dsh-plugin-pack/import
 */
import fs from 'node:fs';
import path from 'node:path';

import { readZipMeta, extractEntry, safeJoin } from './zip.js';
import { readTgz } from './tar.js';
import { dshHome as resolveDshHome, profileDir as resolveProfileDir, profileName as resolveProfileName, packSegment, stamp, humanBytes } from './home.js';
import { readJson, readText, writeJson, writeText, ensureDir, isDir, isFile, realOrSelf, copyTree, removeTree } from './util.js';
import { existingIds, rowId, appendInsertBlock, splitTopLevel, yamlScalar } from './patch-text.js';
import { isAbsoluteSpec, clearScanCache } from './scan.js';

export const PACK_FORMAT = 'dsh-plugin-pack@2';
/** 兼容旧的散文件布局。 */
export const PACK_FORMAT_V1 = 'dsh-plugin-pack@1';

/**
 * 把整合包里的一个插件 tgz 解到目标目录。
 *
 * npm tarball 的内容都在 package/ 下，解出来要去掉这一层；
 * 也兼容没有 package/ 前缀的手工包。所有路径都防穿越。
 *
 * @param {Buffer} zipBuffer 整个整合包
 * @param {object|null} tgzEntry 该插件在 zip 里的条目（readZipMeta 的记录）
 * @param {string} dest 目标目录
 * @returns {number} 写出的文件数
 */
function extractTarballInto(zipBuffer, tgzEntry, dest) {
  if (!tgzEntry) {
    const error = new Error('整合包里找不到这个插件的 .tgz');
    error.code = 'BAD_PACK';
    throw error;
  }
  const tgzBuffer = extractEntry(zipBuffer, tgzEntry);
  const items = readTgz(tgzBuffer);
  if (!items.length) {
    const error = new Error(`插件 tgz 是空的: ${tgzEntry.name}`);
    error.code = 'BAD_PACK';
    throw error;
  }

  const hasPrefix = items.every((item) => item.name.startsWith('package/'));
  const base = path.resolve(dest);
  let written = 0;

  for (const item of items) {
    let rel = String(item.name).replace(/\\/g, '/');
    if (hasPrefix) rel = rel.slice('package/'.length);
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '..' || seg === '.')) continue;
    const target = path.join(base, ...segments);
    if (!path.resolve(target).startsWith(base)) continue;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, item.data);
    written += 1;
  }
  return written;
}

/**
 * 读一个整合包，返回清单和体积统计（不写盘）。
 *
 * 用 readZipMeta 只解析中央目录，再单独解 manifest.json 一条，
 * 几百 MB 的包也只占 manifest 的内存。
 *
 * @param {string} file
 * @returns {object}
 */
export function inspectBundle(file) {
  const target = path.resolve(file);
  if (!isFile(target)) {
    const error = new Error(`整合包不存在: ${target}`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  const buffer = fs.readFileSync(target);

  // 先确认这真的是个 zip。用户可能拖进来任何文件（改名的 rar、半下载的包等），
  // readZipMeta 会抛「找不到 EOCD」，那种原始报错看不懂。
  let records;
  try {
    records = readZipMeta(buffer);
  } catch (zipError) {
    const error = new Error(
      `zip 不是整合包：这个文件不是有效的 zip 压缩包（${String(zipError?.message ?? zipError).slice(0, 80)}）。` +
        `请确认它是 dsh-plugin-pack 导出的 .zip 或单个插件的 .tgz。`,
    );
    error.code = 'NOT_A_ZIP';
    throw error;
  }
  let bufferRef = buffer;

  const manifestRecord = records.find((record) => record.name === 'manifest.json');
  if (!manifestRecord) {
    // 是 zip，但不是整合包（普通的压缩包、别的工具导出的包）
    const error = new Error(
      `zip 不是整合包：这个 zip 里没有 manifest.json（根目录下共 ${records.length} 个文件）。` +
        `它可能是普通的压缩包，或者是别的工具打的包，不是 dsh-plugin-pack 导出的整合包。`,
    );
    error.code = 'NOT_A_BUNDLE';
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(extractEntry(bufferRef, manifestRecord).toString('utf8'));
  } catch (error) {
    const wrapped = new Error(
      `zip 不是整合包：manifest.json 无法解析（${error?.message ?? error}），文件可能损坏。`,
    );
    wrapped.code = 'BAD_MANIFEST';
    throw wrapped;
  }
  // 同时接受 v1（散文件）与 v2（内部 tgz）
  const KNOWN_FORMATS = new Set(['dsh-plugin-pack@1', 'dsh-plugin-pack@2']);
  if (!KNOWN_FORMATS.has(String(manifest?.format))) {
    const error = new Error(
      `zip 不是整合包：manifest.json 的格式标识是「${manifest?.format ?? '(缺失)'}」，` +
        `不是 dsh-plugin-pack 的 @1 或 @2。`,
    );
    error.code = 'BAD_FORMAT';
    throw error;
  }

  // 两种布局都认：
  //   v1（旧）：packages/<段>/<文件...>   —— 散文件
  //   v2（新）：packages/<包名>-<版本>.tgz —— 每个插件一个 npm tarball
  const layout = manifest.layout === 'tarballs' || String(manifest.format) === 'dsh-plugin-pack@2' ? 'tarballs' : 'files';

  const packages = new Map(); // segment -> [{ rel, entry }]（v1 用）
  const tarballs = new Map(); // segment -> record（v2 用）
  const data = new Map();

  for (const record of records) {
    if (record.name.startsWith('packages/')) {
      const rest = record.name.slice('packages/'.length);
      if (layout === 'tarballs') {
        // packages/<name>-<version>.tgz 或 packages/<name>.tgz
        if (!/\.(tgz|tar\.gz)$/i.test(rest)) continue;
        const base = rest.replace(/\.(tgz|tar\.gz)$/i, '');
        tarballs.set(base, record);
        continue;
      }
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const segment = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      if (!rel) continue;
      if (!packages.has(segment)) packages.set(segment, []);
      packages.get(segment).push({ rel, entry: record });
      continue;
    }
    if (record.name.startsWith('data/')) {
      const rest = record.name.slice('data/'.length);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const segment = rest.slice(0, slash);
      const rel = rest.slice(slash + 1);
      if (!rel) continue;
      if (!data.has(segment)) data.set(segment, []);
      data.get(segment).push({ rel, entry: record });
    }
  }

  const plugins = (Array.isArray(manifest.plugins) ? manifest.plugins : []).map((plugin) => {
    const segment = packSegment(plugin.name);
    const files = packages.get(segment) ?? [];

    // v2：按 manifest 里记的 tgz 路径找，找不到就按「包名-版本」猜
    let tgzRecord = null;
    if (layout === 'tarballs') {
      const declared = typeof plugin.tgz === 'string' ? plugin.tgz.replace(/^packages\//, '').replace(/\.(tgz|tar\.gz)$/i, '') : null;
      if (declared && tarballs.has(declared)) tgzRecord = tarballs.get(declared);
      else tgzRecord = tarballs.get(`${segment}-${plugin.version}`) ?? tarballs.get(segment) ?? null;
    }

    const hasPackageJson = layout === 'tarballs' ? Boolean(tgzRecord) : files.some((item) => item.rel === 'package.json');

    return {
      name: plugin.name,
      version: plugin.version,
      kind: plugin.kind,
      segment,
      layout,
      tgz: tgzRecord ? tgzRecord.name : null,
      tgzEntry: tgzRecord,
      files: layout === 'tarballs' ? (tgzRecord ? 1 : 0) : files.length,
      bytes: layout === 'tarballs' ? (tgzRecord ? tgzRecord.size : 0) : files.reduce((sum, item) => sum + item.entry.size, 0),
      dataFiles: (data.get(segment) ?? []).length,
      patchRows: Array.isArray(plugin.patchRows) ? plugin.patchRows.length : 0,
      insertRows: Array.isArray(plugin.insertRows) ? plugin.insertRows.length : 0,
      deps: Array.isArray(plugin.deps) ? plugin.deps.length : 0,
      hasPackageJson,
      manifest: plugin,
    };
  });

  return {
    file: target,
    bytes: buffer.length,
    createdAt: manifest.createdAt,
    source: manifest.source ?? {},
    manifest,
    plugins,
    packages,
    data,
    records,
    get buffer() {
      return bufferRef;
    },
    entryCount: records.length,
    warnings: [
      ...(Array.isArray(manifest.warnings) ? manifest.warnings : []),
      ...plugins.filter((plugin) => !plugin.hasPackageJson).map((plugin) => `${plugin.name}: 包里没有 package.json`),
    ],
  };
}

/**
 * 导入整合包。
 *
 * @param {object} options
 * @param {string} options.file
 * @param {boolean} [options.dryRun]
 * @param {'merge'|'skip'} [options.mode]
 * @param {boolean} [options.overwritePatchConfig]
 * @param {boolean} [options.restoreData]
 * @param {boolean} [options.linkNodeModules]
 * @param {string[]|null} [options.only]
 * @returns {object}
 */
export function importBundle(options = {}) {
  const env = options.env ?? process.env;
  const home = options.dshHome ? path.resolve(options.dshHome) : resolveDshHome(env);
  const profile = options.profileDir ? path.resolve(options.profileDir) : resolveProfileDir(env);
  const profileLabel = options.profileName ?? resolveProfileName(env);
  const mode = options.mode === 'skip' ? 'skip' : 'merge';
  const dryRun = Boolean(options.dryRun);
  /** 进度回调：后台任务管理器用它显示"进行到哪一步"。 */
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const overwritePatchConfig = Boolean(options.overwritePatchConfig);
  const restoreData = options.restoreData !== false;
  const linkNodeModules = options.linkNodeModules !== false;

  /* 逐插件决策：{ "<包名>": "overwrite" | "skip" }。
   * 优先级最高 —— 界面弹窗后按用户对每个插件的选择传进来。
   * 没列到的插件退回全局 mode（merge=覆盖 / skip=跳过）。 */
  const decisions = options.decisions && typeof options.decisions === 'object' ? options.decisions : {};

  const decisionFor = (name) => {
    const picked = decisions[name];
    if (picked === 'overwrite' || picked === 'skip') return picked;
    return mode === 'skip' ? 'skip' : 'overwrite';
  };

  const pack = inspectBundle(options.file);
  const only = Array.isArray(options.only) && options.only.length ? new Set(options.only) : null;
  const chosen = pack.plugins.filter((plugin) => !only || only.has(plugin.name));
  if (!chosen.length) {
    const error = new Error('整合包里没有要导入的插件（only 过滤后为空）');
    error.code = 'EMPTY_SELECTION';
    throw error;
  }

  const localPluginsDir = path.join(profile, 'local-plugins');
  const pkgFile = path.join(profile, 'package.json');
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const pkg = readJson(pkgFile, { name: `dsh-profile-${profileLabel}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } });
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? { ...pkg.dependencies } : {};
  const patchText = readText(patchFile, '') ?? '';
  const knownIds = existingIds(patchText);

  const plan = [];
  const warnings = [...pack.warnings];
  for (const plugin of chosen) {
    const dest = path.join(localPluginsDir, plugin.segment);
    const nodeLink = path.join(profile, 'node_modules', ...String(plugin.name).split('/'));
    const exists = isDir(dest);
    const linkState = describeLink(nodeLink, dest);
    // 路径插件：只在 cordis.patch.yml 里用绝对路径 insert、没进 bundles 的（如 pwsh7-preference）。
    // 导入后 name 重写成新位置的绝对文件路径，不进 bundles / dependencies / 链接。
    const sources = Array.isArray(plugin.manifest?.sources) ? plugin.manifest.sources : [];
    const pathPlugin = sources.includes('patch-path') && !plugin.manifest?.inBundles;
    const specifier = pathPlugin
      ? `${profile}/local-plugins/${plugin.segment}/${plugin.manifest?.entry || 'index.js'}`.replace(/\\/g, '/')
      : plugin.name;
    plan.push({
      name: plugin.name,
      version: plugin.version,
      segment: plugin.segment,
      files: plugin.files,
      bytes: plugin.bytes,
      dest,
      exists,
      action: exists ? decisionFor(plugin.name) : 'create',
      nodeLink,
      linkState,
      pathPlugin,
      specifier,
      inBundles: bundles.includes(plugin.name),
      dependency: dependencies[plugin.name] ?? null,
      patchRows: plugin.patchRows,
      insertRows: plugin.insertRows,
      dataFiles: plugin.dataFiles,
      plugin,
    });
  }

  const patchPlan = planPatch({ plan, patchText, knownIds, overwritePatchConfig, warnings });
  const bundleAdds = plan.filter((item) => !item.pathPlugin && !item.inBundles).map((item) => item.name);

  /* 与已装插件的冲突清单。
   * 界面拿它弹窗问"覆盖还是跳过"，再把决定塞回 decisions。
   * dryRun 也返回它 —— 这正是界面判断"要不要弹窗"的依据。 */
  const conflicts = plan
    .filter((item) => item.exists)
    .map((item) => {
      const installed = readJson(path.join(item.dest, 'package.json'), null);
      return {
        name: item.name,
        version: item.version,
        installedVersion: installed?.version ?? null,
        dest: item.dest,
        bytes: item.bytes,
        // 同一个版本还是不同版本，界面可以据此给更明确的提示
        sameVersion: installed?.version === item.version,
      };
    });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      file: pack.file,
      profile,
      profileLabel,
      mode,
      plugins: plan.map(({ patchRows, insertRows, plugin, ...rest }) => rest),
      // 冲突清单：界面据此弹窗问覆盖还是跳过
      conflicts,
      bundlesToAdd: bundleAdds,
      patch: patchPlan.summary,
      warnings,
      restartRequired: true,
    };
  }

  // ---- 真正开始写 ----
  onProgress(`读取整合包（${pack.plugins.length} 个插件）`, 5);
  const stampText = stamp();
  const backupRoot = uniqueBackupDir(path.join(profile, '.plugin-backups', `plugin-pack-${stampText}`));
  ensureDir(backupRoot);
  const record = {
    format: 'dsh-plugin-pack-backup@1',
    stamp: stampText,
    createdAt: new Date().toISOString(),
    source: pack.file,
    profile,
    profileLabel,
    addedDirs: [],
    replacedDirs: [],
    restoredDirs: [],
    dataDirs: [],
    links: [],
    removedLinks: [],
  };

  if (isFile(pkgFile)) {
    ensureDir(backupRoot);
    fs.copyFileSync(pkgFile, path.join(backupRoot, 'package.json'));
  }
  if (isFile(patchFile)) {
    ensureDir(backupRoot);
    fs.copyFileSync(patchFile, path.join(backupRoot, 'cordis.patch.yml'));
  }

  const applied = [];
  const totalPlugins = plan.length;
  for (let index = 0; index < plan.length; index += 1) {
    const item = plan[index];
    const basePercent = 10 + Math.round((index / Math.max(1, totalPlugins)) * 70);
    if (item.action === 'skip') {
      onProgress(`跳过 ${item.name}（已存在）`, basePercent);
      applied.push({ name: item.name, action: 'skipped', reason: '目标已存在，mode=skip' });
      continue;
    }
    onProgress(`解包 ${item.name}`, basePercent);
    if (item.exists) {
      const backupDir = path.join(backupRoot, 'local-plugins', item.segment);
      copyTree(item.dest, backupDir);
      record.replacedDirs.push({ dest: item.dest, backup: backupDir });
      removeTree(item.dest);
    }
    ensureDir(item.dest);

    // v2：每个插件一个 tgz，解包到目标目录（去掉 package/ 前缀）
    const pluginInfo = chosen.find((entry) => entry.segment === item.segment);
    let written = 0;
    if (pack.manifest?.layout === 'tarballs' || pack.manifest?.format === 'dsh-plugin-pack@2') {
      written = extractTarballInto(pack.buffer, pluginInfo?.tgzEntry, item.dest);
    } else {
      // v1：散文件逐条写
      const files = pack.packages.get(item.segment) ?? [];
      for (const file of files) {
        const target = safeJoin(item.dest, file.rel);
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, extractEntry(pack.buffer, file.entry));
        written += 1;
      }
    }

    if (!item.exists) record.addedDirs.push(item.dest);
    applied.push({ name: item.name, action: item.action, files: written, dest: item.dest });
  }

  // 数据目录
  if (restoreData) {
    for (const plugin of chosen) {
      const dataFiles = pack.data.get(plugin.segment) ?? [];
      for (const file of dataFiles) {
        const [top, ...rest] = file.rel.split('/');
        if (!top || !rest.length) continue;
        const destRoot = path.join(home, top);
        const target = safeJoin(destRoot, rest.join('/'));
        if (!isFile(target)) {
          ensureDir(path.dirname(target));
          fs.writeFileSync(target, extractEntry(pack.buffer, file.entry));
          record.dataDirs.push(target);
        }
      }
    }
  }

  // profile/package.json
  onProgress('写回 profile 配置', 85);
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
  for (const item of plan) {
    if (item.action === 'skip' || item.pathPlugin) continue;
    pkg.dependencies[item.name] = `link:./local-plugins/${item.segment}`;
    if (!pkg.dsh.profile.bundles.includes(item.name)) pkg.dsh.profile.bundles.push(item.name);
  }
  writeJson(pkgFile, pkg);

  // cordis.patch.yml
  let nextPatch = patchText;
  if (patchPlan.topRows.length) nextPatch = appendTopRows(nextPatch, patchPlan.topRows, `plugin-pack ${stampText}`);
  if (patchPlan.insertRows.length) {
    nextPatch = appendInsertBlock(nextPatch, dedentRows(patchPlan.insertRows), `plugin-pack ${stampText}`).text;
  }
  if (nextPatch !== patchText) writeText(patchFile, nextPatch);

  // node_modules 链接
  onProgress('建立 node_modules 链接', 92);
  const links = [];
  if (linkNodeModules) {
    for (const item of plan) {
      if (item.action === 'skip' || item.pathPlugin) continue;
      const result = ensurePackageLink(profile, item.name, item.dest, { backupRoot, record });
      links.push({ name: item.name, ...result });
    }
  }

  record.links = links;
  writeJson(path.join(backupRoot, 'record.json'), record);
  // 导入改了 profile 配置和插件目录，扫描缓存必须失效
  clearScanCache();
  onProgress(`完成：${applied.length} 个插件已处理`, 100);

  return {
    ok: true,
    file: pack.file,
    profile,
    profileLabel,
    backup: backupRoot,
    mode,
    plugins: applied,
    conflicts,
    decisions: Object.fromEntries(plan.filter((item) => item.exists).map((item) => [item.name, item.action])),
    links,
    bundlesAdded: bundleAdds,
    patch: patchPlan.summary,
    dataRestored: record.dataDirs.length,
    warnings,
    restartRequired: true,
  };
}

/** 计算 patch 的增补计划（不写盘）。 */
function planPatch({ plan, patchText, knownIds, overwritePatchConfig, warnings }) {
  const topRows = [];
  const insertRows = [];
  const skipped = [];
  const ids = new Set(knownIds);
  const entries = splitTopLevel(patchText);
  const byId = new Map(entries.filter((entry) => entry.kind === 'row' && entry.id).map((entry) => [entry.id, entry]));

  for (const item of plan) {
    for (const raw of item.plugin?.manifest?.patchRows ?? []) {
      const id = rowId(raw);
      if (!id) continue;
      if (ids.has(id)) {
        if (overwritePatchConfig && byId.has(id)) {
          skipped.push({ id, reason: '已存在，overwritePatchConfig=true 时按原行保留（避免破坏用户手改）' });
        } else {
          skipped.push({ id, reason: 'id 已存在，跳过' });
        }
        continue;
      }
      ids.add(id);
      topRows.push(rewriteRowName(raw, item.specifier));
    }
    for (const raw of item.plugin?.manifest?.insertRows ?? []) {
      const id = rowId(raw);
      if (!id) continue;
      if (ids.has(id)) {
        skipped.push({ id, reason: 'id 已存在，跳过' });
        continue;
      }
      ids.add(id);
      insertRows.push(rewriteRowName(raw, item.specifier));
    }
  }

  if (skipped.length) {
    warnings.push(`patch 有 ${skipped.length} 条已存在，未重复写入：${skipped.map((item) => item.id).join(', ')}`);
  }

  return {
    topRows,
    insertRows,
    summary: {
      topRows: topRows.length,
      insertRows: insertRows.length,
      skipped,
    },
  };
}

/** 把 row 里写死的绝对路径 name 改成新位置（包名或新的绝对路径，按 YAML 规则安全化）。 */
function rewriteRowName(raw, specifier) {
  return String(raw).replace(
    /(^|[ \t])name:([ \t]*)(['"]?)([^'"\r\n]+)\3/g,
    (match, lead, gap, quote, value) => {
      const trimmed = value.trim();
      if (!isAbsoluteSpec(trimmed)) return match;
      return `${lead}name:${gap}${yamlScalar(specifier)}`;
    },
  );
}

/** 顶层 row 追加。 */
function appendTopRows(text, rows, comment) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  let out = String(text ?? '');
  if (out && !out.endsWith('\n')) out += eol;
  if (out && !out.endsWith(`${eol}${eol}`)) out += eol;
  out += `# >>> dsh-plugin-pack ${comment}${eol}`;
  for (const row of rows) {
    const body = String(row).replace(/\r?\n$/, '').replace(/\r?\n/g, eol);
    out += `${body}${eol}`;
  }
  return out;
}

/**
 * 把 insert 子条目原文（4 空格缩进）还原成顶层行形态（0 缩进），
 * 再交给 appendIndentBlock 统一加 4 —— 否则会双重缩进，
 * splitInsertChildren（只认 4 空格）就收集不到它的 id，导致重复导入。
 */
function dedentRows(rows) {
  return rows.map((raw) =>
    String(raw)
      .split(/\r?\n/)
      .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
      .join('\n'),
  );
}

/** 描述目标 node_modules 位置当前是什么状态。 */
function describeLink(linkPath, dest) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const real = realOrSelf(linkPath);
      return real === realOrSelf(dest) ? 'linked-to-dest' : `linked-elsewhere:${real}`;
    }
    if (stat.isDirectory()) return 'directory';
    return 'file';
  } catch {
    return 'missing';
  }
}

/** 建立 node_modules/<name> → local-plugins/<segment> 的链接。 */
function ensurePackageLink(profile, name, dest, { backupRoot, record }) {
  const linkPath = path.join(profile, 'node_modules', ...String(name).split('/'));
  const state = describeLink(linkPath, dest);
  if (state === 'linked-to-dest') return { status: 'already', path: linkPath };
  try {
    if (state === 'directory' || state === 'file') {
      const backup = path.join(backupRoot, 'node_modules', packSegment(name));
      copyTree(linkPath, backup);
      record.replacedDirs.push({ dest: linkPath, backup });
      removeTree(linkPath);
    } else if (state.startsWith('linked-elsewhere')) {
      // 原链接（pnpm 建的）删之前把目标记下来，回滚时要原样重建。
      const previousTarget = fs.readlinkSync(linkPath);
      record.removedLinks.push({ path: linkPath, target: previousTarget });
      fs.unlinkSync(linkPath);
    }
  } catch (error) {
    return { status: 'failed', path: linkPath, error: `清理旧位置失败: ${error?.message ?? error}` };
  }
  try {
    ensureDir(path.dirname(linkPath));
    fs.symlinkSync(dest, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'linked', path: linkPath };
  } catch (error) {
    return {
      status: 'failed',
      path: linkPath,
      error: `建链接失败: ${error?.message ?? error}。可手动跑 pnpm install 让 link: 依赖生效`,
    };
  }
}

/** 备份目录撞名（同一秒内多次导入）时追加序号，不覆盖旧备份。 */
function uniqueBackupDir(base) {
  if (!isDir(base) && !isFile(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`;
    if (!isDir(candidate) && !isFile(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** 按记录重建一条链接；junction 优先（Windows 不需要特权），失败退回 symlink。 */
function relink(recorded) {
  try {
    try {
      fs.lstatSync(recorded.path);
      fs.unlinkSync(recorded.path);
    } catch {
      /* 已经不在了 */
    }
    if (process.platform === 'win32') {
      try {
        fs.symlinkSync(recorded.target, recorded.path, 'junction');
        return;
      } catch {
        /* 退回 symlink */
      }
    }
    fs.symlinkSync(recorded.target, recorded.path, 'dir');
  } catch {
    /* 重建失败：留报告里 */
  }
}

/**
 * 回滚最近一次（或指定一次）导入。
 *
 * @param {object} [options]
 * @param {string} [options.backup] 备份目录名或绝对路径
 * @returns {object}
 */
export function rollbackImport(options = {}) {
  const env = options.env ?? process.env;
  const profile = options.profileDir ? path.resolve(options.profileDir) : resolveProfileDir(env);
  const backupRoot = resolveBackupDir(profile, options.backup);
  const record = readJson(path.join(backupRoot, 'record.json'), null);
  if (!record) {
    const error = new Error(`备份里没有 record.json，无法安全回滚: ${backupRoot}`);
    error.code = 'BAD_BACKUP';
    throw error;
  }

  const restored = [];
  const removed = [];
  const relinked = [];

  const backupPkg = path.join(backupRoot, 'package.json');
  const backupPatch = path.join(backupRoot, 'cordis.patch.yml');
  if (isFile(backupPkg)) {
    fs.copyFileSync(backupPkg, path.join(profile, 'package.json'));
    restored.push('package.json');
  }
  if (isFile(backupPatch)) {
    fs.copyFileSync(backupPatch, path.join(profile, 'cordis.patch.yml'));
    restored.push('cordis.patch.yml');
  }

  for (const dest of record.addedDirs ?? []) {
    removeTree(dest);
    removed.push(dest);
  }
  for (const item of record.replacedDirs ?? []) {
    if (!isDir(item.backup)) continue;
    removeTree(item.dest);
    copyTree(item.backup, item.dest);
    restored.push(item.dest);
  }
  // 先删掉本次导入创建的链接，再重建被替换的原链接（同一路径，顺序不能反）。
  for (const link of record.links ?? []) {
    if (link?.status === 'linked' && link.path) {
      try {
        fs.lstatSync(link.path);
        fs.unlinkSync(link.path);
        relinked.push(link.path);
      } catch {
        /* 已经不在了 */
      }
    }
  }
  for (const recorded of record.removedLinks ?? []) {
    // 兼容旧格式（纯字符串）与新格式（{ path, target }）
    const info = typeof recorded === 'string' ? { path: recorded, target: null } : recorded;
    if (!info?.path) continue;
    if (info.target) {
      relink(info);
      restored.push(`${info.path} -> ${info.target}`);
    }
  }
  for (const file of record.dataDirs ?? []) {
    removeTree(file);
    removed.push(file);
  }

  // 标记该备份已消费：重命名加 .done，之后「最新备份」指向更早的、还没回滚过的那次。
  try {
    const done = `${backupRoot}.done`;
    fs.renameSync(backupRoot, done);
    return {
      ok: true,
      backup: backupRoot,
      backupArchived: done,
      restored,
      removed,
      unlinked: relinked,
      restartRequired: true,
    };
  } catch {
    /* 重命名失败不影响回滚结果 */
  }

  // 回滚改了配置和插件目录，扫描缓存失效
  clearScanCache();

  return {
    ok: true,
    backup: backupRoot,
    restored,
    removed,
    unlinked: relinked,
    restartRequired: true,
  };
}

/** 找备份目录：给了就用，没给就取最新（跳过已消费的 .done）。 */
export function resolveBackupDir(profile, raw) {
  const root = path.join(profile, '.plugin-backups');
  if (raw && String(raw).trim()) {
    const value = String(raw).trim();
    const direct = path.isAbsolute(value) ? value : path.join(root, value);
    if (isDir(direct)) return direct;
    if (isDir(`${direct}.done`)) {
      const error = new Error(`该备份已经回滚过了: ${direct}`);
      error.code = 'ALREADY_DONE';
      throw error;
    }
    const error = new Error(`备份目录不存在: ${direct}`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-pack-') && !entry.name.endsWith('.done'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    names = [];
  }
  if (!names.length) {
    const error = new Error(`没有找到任何还没回滚过的 plugin-pack 备份: ${root}`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  return path.join(root, names[names.length - 1]);
}

/** 列出所有可回滚的备份（已消费的 .done 不算）。 */
export function listBackups(profileDir) {
  const root = path.join(profileDir, '.plugin-backups');
  let names = [];
  try {
    names = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('plugin-pack-') && !entry.name.endsWith('.done'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return names.map((name) => {
    const dir = path.join(root, name);
    const record = readJson(path.join(dir, 'record.json'), null);
    return {
      name,
      dir,
      createdAt: record?.createdAt ?? null,
      source: record?.source ?? null,
      plugins: (record?.addedDirs ?? []).length + (record?.replacedDirs ?? []).length,
    };
  });
}
