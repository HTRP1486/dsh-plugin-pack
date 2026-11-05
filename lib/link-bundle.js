/**
 * 「链接整合包」：manifest 里只存插件的来源地址，不内嵌任何插件文件。
 *
 * 为什么要这种格式：
 *   - 普通整合包把插件 tgz 塞进 zip，体积大（几十~几百 MB），且内容会过期
 *   - 链接整合包只有几 KB，装的时候按地址现取，永远拿最新版
 *
 * 格式（manifest.json）：
 *   {
 *     "format": "dsh-plugin-pack@2",
 *     "layout": "links",
 *     "plugins": [
 *       { "name": "dsh-plugin-pet", "source": "https://github.com/c-ling/dsh-plugin-pet" },
 *       { "name": "dsh-plugin-pack", "source": "dsh-plugin-pack" }   // npm 包名也行
 *     ]
 *   }
 *
 * 导入时逐个下载 → 复用已有的「单插件目录导入 / tgz 导入」逻辑落地。
 *
 * @module dsh-plugin-pack/lib/link-bundle
 */
import fs from 'node:fs';
import path from 'node:path';

import { readZip } from './zip.js';
import { readJson, isDir } from './util.js';
import { packSegment } from './home.js';
import { resolvePackageDir } from './scan.js';

/** 判断一个 zip 是不是「链接整合包」。是则返回解析结果，否则 null。 */
export function readLinkBundle(file) {
  try {
    const buffer = fs.readFileSync(file);
    // readZip 返回的条目已经带解压后的 data，直接用，不用再 extractEntry
    const records = readZip(buffer);
    const manifestRecord = records.find((record) => record.name === 'manifest.json');
    if (!manifestRecord) return null;

    const manifest = JSON.parse(manifestRecord.data.toString('utf8'));
    if (String(manifest?.layout ?? '') !== 'links') return null;
    if (!String(manifest?.format ?? '').startsWith('dsh-plugin-pack@')) return null;

    const plugins = (Array.isArray(manifest.plugins) ? manifest.plugins : [])
      .filter((plugin) => plugin && typeof plugin.source === 'string' && plugin.source.trim())
      .map((plugin) => ({
        name: String(plugin.name ?? plugin.source).trim(),
        version: plugin.version ?? null,
        source: String(plugin.source).trim(),
      }));

    return { manifest, plugins, file };
  } catch {
    return null;
  }
}

/** 已装版本（不下载，只看本地）。 */
function installedInfo(profileDir, name) {
  const pkg = readJson(path.join(profileDir, 'package.json'), null);
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
  const localDir = path.join(profileDir, 'local-plugins', packSegment(name));
  const resolved = resolvePackageDir(name, profileDir, dependencies) ?? (isDir(localDir) ? localDir : null);
  if (!resolved) return null;
  const meta = readJson(path.join(resolved, 'package.json'), null);
  // 只认声明过的：磁盘上留着文件但没声明的是卸载残留，不算"已装"
  const declared = Boolean(dependencies[name]) || bundles.includes(name);
  if (!declared) return null;
  return {
    installedVersion: meta?.version ?? null,
    dest: resolved,
    installedSpec: dependencies[name] ?? null,
    stale: false,
  };
}

/**
 * 导入「链接整合包」。
 *
 * @param {object} options
 * @param {string} options.file zip 路径
 * @param {string} options.profileDir
 * @param {string} options.home $DSH_HOME
 * @param {boolean} [options.dryRun] 只算冲突，不下载不写盘
 * @param {boolean} [options.enable]
 * @param {Record<string,'overwrite'|'skip'>} [options.decisions]
 * @param {(message: string, percent?: number) => void} [options.onProgress]
 * @returns {Promise<object>}
 */
export async function importLinkBundle({
  file,
  profileDir,
  home,
  dryRun = false,
  enable = true,
  decisions = {},
  onProgress = () => {},
}) {
  const bundle = readLinkBundle(file);
  if (!bundle) {
    const error = new Error('不是链接整合包：manifest.json 里没有 layout: links');
    error.code = 'NOT_A_BUNDLE';
    throw error;
  }
  if (!bundle.plugins.length) {
    const error = new Error('链接整合包里没有可安装的插件（plugins 为空或缺少 source）');
    error.code = 'EMPTY_SELECTION';
    throw error;
  }

  // 冲突先算出来（这一步不用下载，只看本地有没有同名插件）
  const conflicts = [];
  for (const plugin of bundle.plugins) {
    const local = installedInfo(profileDir, plugin.name);
    if (!local) continue;
    conflicts.push({
      name: plugin.name,
      version: plugin.version,
      installedVersion: local.installedVersion,
      dest: local.dest,
      sameVersion: local.installedVersion === plugin.version,
      installSource: local.stale ? 'stale' : /^link:/i.test(String(local.installedSpec ?? '')) ? 'local-plugins' : 'npm',
      installedSpec: local.installedSpec,
      older: false,
      stale: Boolean(local.stale),
      source: plugin.source,
    });
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      kind: 'link-bundle',
      plugins: bundle.plugins.map((plugin) => ({
        name: plugin.name,
        version: plugin.version,
        exists: conflicts.some((item) => item.name === plugin.name),
        source: plugin.source,
      })),
      conflicts,
      warnings: [],
      restartRequired: true,
    };
  }

  const { fetchBundleFrom } = await import('./fetch-bundle.js');
  const { importLocalPlugin } = await import('./import-plugin.js');
  const { importTarball } = await import('./import-tgz.js');

  const applied = [];
  const warnings = [];
  const total = bundle.plugins.length;

  for (let index = 0; index < total; index += 1) {
    const plugin = bundle.plugins[index];
    const percent = Math.round((index / total) * 90) + 5;
    const decision = decisions[plugin.name] === 'skip' ? 'skip' : 'overwrite';
    const alreadyInstalled = conflicts.some((item) => item.name === plugin.name);

    if (alreadyInstalled && decision === 'skip') {
      onProgress(`跳过 ${plugin.name}（已安装）`, percent);
      applied.push({ name: plugin.name, action: 'skipped', reason: '用户选择跳过' });
      continue;
    }

    onProgress(`下载 ${plugin.name} ← ${plugin.source}`, percent);
    try {
      const fetched = await fetchBundleFrom({ source: plugin.source, home, onProgress: () => {} });

      if (fetched.kind === 'plugin' && fetched.dir) {
        const result = await importLocalPlugin({
          dir: fetched.dir,
          profileDir,
          enable,
          mode: 'merge',
        });
        applied.push({ name: result.name, version: result.version, action: alreadyInstalled ? 'overwrite' : 'create' });
      } else if (fetched.kind === 'plugin') {
        const result = await importTarball({
          file: fetched.file,
          home,
          profileDir,
          enable,
          mode: 'merge',
          keepNodeModules: true,
        });
        applied.push({ name: result.name ?? plugin.name, version: result.version, action: alreadyInstalled ? 'overwrite' : 'create' });
      } else {
        // 链接指向的其实是个整合包：递归导入
        const { importBundle } = await import('./import.js');
        const result = importBundle({ file: fetched.file, profileDir, enable, mode: 'merge' });
        for (const item of result.plugins ?? []) {
          applied.push({ name: item.name, action: item.action, files: item.files });
        }
      }
    } catch (error) {
      warnings.push(`${plugin.name}: 安装失败（${String(error?.message ?? error).slice(0, 120)}）`);
    }
  }

  onProgress(`完成：${applied.length} 个插件已处理`, 100);

  return {
    ok: true,
    kind: 'link-bundle',
    file,
    profileDir,
    plugins: applied,
    conflicts,
    enabled: Boolean(enable),
    warnings,
    restartRequired: true,
  };
}
