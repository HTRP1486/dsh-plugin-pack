/**
 * 扫描当前 profile 里所有「第三方插件」，以及它们各自的依赖闭包、
 * 在 cordis.patch.yml 里的配置行、可选的插件数据目录。
 *
 * 这里不碰网络、不写文件，只读。
 *
 * @module dsh-plugin-pack/scan
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { dshHome as resolveDshHome, profileDir as resolveProfileDir, profileName as resolveProfileName } from './home.js';
import { readJson, readText, realOrSelf, isDir, isFile, measureTree, measureTreeAsync, SKIP_DIRS, fileFilter } from './util.js';
import { splitTopLevel, splitInsertChildren, entryMatchesPlugin } from './patch-text.js';

/** 官方包前缀：宿主自带，不进整合包。 */
const OFFICIAL_PREFIX = '@deepseek-ai/';

/**
 * 扫描结果缓存。
 *
 * 一次完整扫描要 3 秒（dsh-ops 9920 个文件、lark-plus 1033 个，每个都要 stat）。
 * 界面一打开就调 status，等于每次干等 3 秒 —— 这就是"加载不出来"的主因。
 * 缓存 60 秒，配置文件 mtime 变了就失效。
 *
 * @type {Map<string, { at: number, value: object, pkgMtime: number, patchMtime: number }>}
 */
const scanCache = new Map();
const SCAN_TTL_MS = 60 * 1000;

/** 清空缓存（导入/导出/回滚后调用，保证下次读到新的体积）。 */
export function clearScanCache() {
  scanCache.clear();
}

/** 这些包永远由宿主提供，即便出现在 dependencies 里也不打包。 */
const HOST_PROVIDED = new Set([
  'react',
  'react-dom',
  '@deepseek-ai/cordis',
]);

/** 一个包是不是官方/宿主提供。 */
export function isOfficial(name) {
  return typeof name === 'string' && (name.startsWith(OFFICIAL_PREFIX) || HOST_PROVIDED.has(name));
}

/** 路径插件（patch 里写死绝对路径）的判断。 */
export function isAbsoluteSpec(value) {
  return typeof value === 'string' && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/'));
}

/**
 * 扫描 profile。
 *
 * @param {object} [options]
 * @param {string} [options.profileDir]
 * @param {string} [options.dshHome]
 * @param {string[]|null} [options.include] 只导出这些包名
 * @param {string[]} [options.exclude] 排除这些包名
 * @param {boolean} [options.includeData] 是否收录插件数据目录
 * @param {boolean} [options.includeSecrets] 是否收录 .env / *.pem 等
 * @param {number} [options.maxBytes] 超过就抛错
 * @param {(root: string, options: object) => Promise<{bytes:number,files:number}>} [options.measure]
 *   测目录体积的实现。默认用异步版（不阻塞事件循环）；测试可注入同步版。
 * @param {boolean} [options.fresh] 跳过缓存强制重扫（导出等需要精确体积的场景）
 * @returns {Promise<object>} 扫描结果
 */
export async function scanProfile(options = {}) {
  const env = options.env ?? process.env;
  const home = options.dshHome ? path.resolve(options.dshHome) : resolveDshHome(env);
  const dir = options.profileDir ? path.resolve(options.profileDir) : resolveProfileDir(env);
  const name = options.profileName ?? resolveProfileName(env);
  const includeSecrets = Boolean(options.includeSecrets);
  const includeData = Boolean(options.includeData);
  const warnings = [];

  const pkgFile = path.join(dir, 'package.json');
  const patchFile = path.join(dir, 'cordis.patch.yml');

  /* 缓存：一次完整扫描要 3 秒（dsh-ops 9920 个文件、lark-plus 1033 个，
   * 每个都要 stat）。界面一打开就调 status，等于每次干等 3 秒。
   * 缓存 60 秒，且配置文件 mtime 一变就失效。 */
  const cacheKey = [dir, includeSecrets ? 's' : '', includeData ? 'd' : '', (options.include ?? []).join('|'), (options.exclude ?? []).join('|')].join('\0');
  if (!options.fresh) {
    const cached = scanCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SCAN_TTL_MS) {
      let stampOk = false;
      try {
        stampOk = fs.statSync(pkgFile).mtimeMs === cached.pkgMtime && fs.statSync(patchFile).mtimeMs === cached.patchMtime;
      } catch {
        stampOk = false;
      }
      if (stampOk) return cached.value;
    }
  }

  const pkg = readJson(pkgFile, null);
  if (!pkg) warnings.push(`没有找到 profile 的 package.json: ${pkgFile}`);

  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
  const dependencies = pkg?.dependencies && typeof pkg.dependencies === 'object' ? { ...pkg.dependencies } : {};

  const patchText = readText(patchFile, '') ?? '';
  const topEntries = splitTopLevel(patchText);

  /** @type {Map<string, object>} key 用真实目录，避免同一插件多路命中。 */
  const found = new Map();

  const addCandidate = (candidate) => {
    const rawDir = candidate.dir ? path.resolve(candidate.dir) : null;
    if (!rawDir || !isDir(rawDir)) return;
    const realDir = realOrSelf(rawDir);
    const key = realDir.toLowerCase();
    const existing = found.get(key);
    if (existing) {
      existing.sources.add(candidate.source);
      if (candidate.inBundles) {
        existing.inBundles = true;
        existing.bundleIndex = candidate.bundleIndex ?? existing.bundleIndex;
      }
      if (candidate.link && !existing.link) existing.link = candidate.link;
      if (candidate.declaredName && !existing.declaredName) existing.declaredName = candidate.declaredName;
      return;
    }
    found.set(key, {
      dir: realDir,
      declaredName: candidate.declaredName ?? null,
      link: candidate.link ?? null,
      inBundles: Boolean(candidate.inBundles),
      bundleIndex: candidate.bundleIndex ?? -1,
      sources: new Set([candidate.source]),
    });
  };

  // 1) bundles 里声明的插件
  bundles.forEach((bundle, index) => {
    if (typeof bundle !== 'string' || isOfficial(bundle)) return;
    const resolved = resolvePackageDir(bundle, dir, dependencies);
    if (!resolved) {
      warnings.push(`bundles 里的 ${bundle} 没有安装到 ${dir}/node_modules，已跳过`);
      return;
    }
    addCandidate({ dir: resolved, declaredName: bundle, link: dependencies[bundle] ?? null, inBundles: true, bundleIndex: index, source: 'bundles' });
  });

  // 2) dependencies 里声明但没进 bundles 的（可能是插件，也可能只是工具库）
  for (const [depName, spec] of Object.entries(dependencies)) {
    if (isOfficial(depName)) continue;
    if ([...found.values()].some((item) => item.declaredName === depName)) continue;
    const resolved = resolvePackageDir(depName, dir, dependencies);
    if (!resolved) continue;
    addCandidate({ dir: resolved, declaredName: depName, link: spec, inBundles: false, source: 'dependencies' });
  }

  // 3) local-plugins 下手工放的
  const localPluginsDir = path.join(dir, 'local-plugins');
  if (isDir(localPluginsDir)) {
    for (const entry of fs.readdirSync(localPluginsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.')) continue;
      addCandidate({ dir: path.join(localPluginsDir, entry.name), declaredName: null, inBundles: false, source: 'local-plugins' });
    }
  }

  // 4) cordis.patch.yml 里用绝对路径 insert 的（如 pwsh7-preference）
  for (const entry of topEntries) {
    for (const value of entry.names) {
      if (!isAbsoluteSpec(value)) continue;
      const target = isFile(value) ? path.dirname(value) : value;
      addCandidate({ dir: target, declaredName: null, inBundles: false, source: 'patch-path' });
    }
  }

  const plugins = [];
  for (const item of found.values()) {
    const plugin = await buildPlugin(item, {
      profileDir: dir,
      dshHome: home,
      topEntries,
      includeSecrets,
      includeData,
      warnings,
      measure: options.measure,
    });
    if (!plugin) continue;
    // dependencies 来源可能是纯工具库：既不是 dsh-* 命名，也没有 dsh 字段，
    // 也没进 bundles / 没被 patch 引用 —— 标记出来但默认不选中。
    const looksLikePlugin =
      plugin.inBundles ||
      plugin.name.startsWith('dsh-') ||
      plugin.hasPatch ||
      Boolean(plugin.client) ||
      plugin.patchRows.length > 0 ||
      plugin.insertRows.length > 0 ||
      item.sources.has('local-plugins') ||
      item.sources.has('patch-path');
    if (!looksLikePlugin) plugin.skipped = 'not-plugin';
    plugins.push(plugin);
  }

  // 排序：bundles 顺序优先，其余按名字
  plugins.sort((a, b) => {
    if (a.bundleIndex !== b.bundleIndex) {
      if (a.bundleIndex < 0) return 1;
      if (b.bundleIndex < 0) return -1;
      return a.bundleIndex - b.bundleIndex;
    }
    return a.name.localeCompare(b.name);
  });

  // include 的三种语义要分清：
  //   未传 / 非数组        → null，表示"不过滤"，导出全部
  //   空数组              → 空 Set，表示"一个都不要"（导出端会因此报 NO_PLUGINS）
  //   有内容的数组        → 只导出这些
  // 以前空数组被当成"不过滤"，导致界面上误传 [] 时会把全部插件都打进去。
  const include = Array.isArray(options.include) ? new Set(options.include) : null;
  const exclude = new Set(Array.isArray(options.exclude) ? options.exclude : []);
  const selected = plugins.filter((plugin) => {
    if (include && !include.has(plugin.name)) return false;
    if (exclude.has(plugin.name)) return false;
    if (plugin.skipped === 'not-plugin' && !include) return false;
    return true;
  });
  for (const plugin of plugins) {
    if (!selected.includes(plugin) && !plugin.skipped) plugin.skipped = 'filtered';
  }

  const totals = selected.reduce(
    (acc, plugin) => {
      acc.bytes += plugin.bytes;
      acc.files += plugin.fileCount;
      return acc;
    },
    { bytes: 0, files: 0 },
  );

  const result = {
    format: 'dsh-plugin-pack@1',
    profile: { name, dir, dshHome: home, bundles, dependencies, patchFile },
    plugins,
    selected,
    totals,
    warnings,
  };

  // 写入缓存（记下两份配置的 mtime，之后据此判断失效）
  try {
    scanCache.set(cacheKey, {
      at: Date.now(),
      value: result,
      pkgMtime: fs.statSync(pkgFile).mtimeMs,
      patchMtime: fs.statSync(patchFile).mtimeMs,
    });
  } catch {
    /* 缓存可有可无 */
  }

  return result;
}

/** 在 profile 的解析上下文里找一个包目录。 */
export function resolvePackageDir(name, profileDir, dependencies = {}) {
  if (!name) return null;
  const segments = name.split('/');
  const direct = path.join(profileDir, 'node_modules', ...segments);
  if (isFile(path.join(direct, 'package.json'))) return realOrSelf(direct);

  const spec = dependencies[name];
  if (typeof spec === 'string' && (spec.startsWith('link:') || spec.startsWith('file:'))) {
    const target = path.resolve(profileDir, spec.slice(spec.indexOf(':') + 1));
    if (isDir(target) && isFile(path.join(target, 'package.json'))) return realOrSelf(target);
  }

  try {
    const require = createRequire(path.join(profileDir, 'package.json'));
    let current = path.dirname(require.resolve(name));
    while (current && current !== path.dirname(current)) {
      if (isFile(path.join(current, 'package.json'))) return realOrSelf(current);
      current = path.dirname(current);
    }
  } catch {
    /* ESM-only 包 require.resolve 会失败，走上面的目录探测 */
  }
  return null;
}

/** 从一个包目录向上找 node_modules/<dep>。 */
function resolveDepDir(fromDir, depName, profileDir) {
  const segments = depName.split('/');
  let current = fromDir;
  for (let i = 0; i < 12; i += 1) {
    const candidate = path.join(current, 'node_modules', ...segments);
    if (isFile(path.join(candidate, 'package.json'))) return realOrSelf(candidate);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const fallback = path.join(profileDir, 'node_modules', ...segments);
  if (isFile(path.join(fallback, 'package.json'))) return realOrSelf(fallback);
  return null;
}

/** 解析包入口（相对包目录）。 */
export function resolveEntry(dir, meta) {
  const candidates = [];
  const exp = meta?.exports;
  if (typeof exp === 'string') candidates.push(exp);
  else if (exp && typeof exp === 'object') {
    const dot = exp['.'] ?? exp;
    if (typeof dot === 'string') candidates.push(dot);
    else if (dot && typeof dot === 'object') {
      for (const key of ['import', 'node', 'default', 'require']) {
        if (typeof dot[key] === 'string') {
          candidates.push(dot[key]);
          break;
        }
      }
    }
  }
  if (typeof meta?.main === 'string') candidates.push(meta.main);
  candidates.push('index.js', 'index.mjs', 'index.cjs', 'lib/index.js', 'dist/index.js');
  for (const candidate of candidates) {
    const target = path.resolve(dir, candidate);
    if (isFile(target)) return path.relative(dir, target).replace(/\\/g, '/');
  }
  return null;
}

/** 依赖闭包（不含 peer / dev / @deepseek-ai）。异步版。 */
async function collectDepsAsync(rootDir, meta, { profileDir, includeSecrets, warnings, measure }) {
  const out = [];
  const seen = new Set();
  const byName = new Map();
  const keepFile = fileFilter({ includeSecrets });
  const queue = [{ dir: rootDir, meta, depth: 0 }];
  while (queue.length) {
    const current = queue.shift();
    if (current.depth > 32) continue;
    const pkg = current.meta ?? readJson(path.join(current.dir, 'package.json'), null);
    if (!pkg) continue;
    const required = Object.keys(pkg.dependencies ?? {});
    const optional = Object.keys(pkg.optionalDependencies ?? {});
    const peer = pkg.peerDependencies ?? {};
    for (const depName of [...required, ...optional]) {
      if (isOfficial(depName) || depName.startsWith('@types/')) continue;
      if (Object.hasOwn(peer, depName)) continue;
      const isOptional = optional.includes(depName) && !required.includes(depName);
      const depDir = resolveDepDir(current.dir, depName, profileDir);
      if (!depDir) {
        if (!isOptional) warnings.push(`依赖没装上，已跳过: ${depName}（来自 ${path.basename(current.dir)}）`);
        continue;
      }
      if (seen.has(depDir)) continue;
      seen.add(depDir);
      const depMeta = readJson(path.join(depDir, 'package.json'), {});
      const size = await measure(depDir, {
        skipDirs: new Set([...SKIP_DIRS, 'node_modules']),
        keepFile,
      });
      const record = {
        name: depName,
        version: depMeta.version ?? '0.0.0',
        dir: depDir,
        bytes: size.bytes,
        files: size.files,
      };
      if (byName.has(depName)) {
        warnings.push(`依赖 ${depName} 出现多个版本，只保留先遇到的那个（${byName.get(depName).version} 优先于 ${record.version}）`);
      } else {
        byName.set(depName, record);
        out.push(record);
      }
      queue.push({ dir: depDir, meta: depMeta, depth: current.depth + 1 });
    }
  }
  return out;
}

/** 从 patch 里挑出属于该插件的行。 */
function matchPatchRows(topEntries, plugin) {
  const patchRows = [];
  const insertRows = [];
  const target = { name: plugin.name, dirs: [plugin.dir, path.join(plugin.dir, 'index.js')] };
  for (const entry of topEntries) {
    if (entry.kind === 'insert') {
      for (const child of splitInsertChildren(entry.raw)) {
        if (entryMatchesPlugin({ ...child, kind: 'row' }, target)) insertRows.push(child.raw);
      }
      continue;
    }
    if (entry.kind !== 'row') continue;
    if (entryMatchesPlugin(entry, target)) patchRows.push(entry.raw);
  }
  return { patchRows, insertRows };
}

/** 插件数据目录候选：$DSH_HOME/<name>、$DSH_HOME/<name 去 dsh- 前缀>、package.json 的 dsh.dataDirs。 */
function findDataDirs(plugin, dshHome, meta) {
  const names = new Set();
  const bare = plugin.name.startsWith('dsh-') ? plugin.name.slice(4) : plugin.name;
  names.add(plugin.name);
  names.add(bare);
  for (const extra of Array.isArray(meta?.dsh?.dataDirs) ? meta.dsh.dataDirs : []) {
    if (typeof extra === 'string' && extra.trim()) names.add(extra.trim());
  }
  const out = [];
  for (const candidate of names) {
    if (candidate.includes('/') || candidate.includes('\\') || candidate === '..') continue;
    const full = path.join(dshHome, candidate);
    if (!isDir(full)) continue;
    if (out.some((item) => item.path === full)) continue;
    out.push({ name: candidate, path: full });
  }
  return out;
}

/** 组装单个插件的扫描记录。 */
/**
 * 组装单个插件的扫描记录（异步）。
 *
 * @param {object} item
 * @param {object} context
 * @param {(root: string, options: object) => Promise<{bytes:number,files:number}>} context.measure
 *   测目录体积的函数。默认用异步版，避免大目录把事件循环卡住。
 */
async function buildPlugin(item, { profileDir, dshHome, topEntries, includeSecrets, includeData, warnings, measure = measureTreeAsync }) {
  const metaFile = path.join(item.dir, 'package.json');
  const meta = readJson(metaFile, null);
  const name = meta?.name ?? item.declaredName ?? path.basename(item.dir);
  if (!name) return null;

  const pluginWarnings = [];
  const entry = resolveEntry(item.dir, meta);
  if (!meta && !entry) {
    pluginWarnings.push('既没有 package.json 也找不到入口文件，可能不是插件目录');
  }

  const skipFileKeep = fileFilter({ includeSecrets });
  const mainSize = await measure(item.dir, {
    skipDirs: new Set([...SKIP_DIRS, 'node_modules']),
    keepFile: skipFileKeep,
  });
  const deps = await collectDepsAsync(item.dir, meta, { profileDir, includeSecrets, warnings: pluginWarnings, measure });

  const patchInfo = matchPatchRows(topEntries, { name, dir: item.dir });

  const dataCandidates = findDataDirs({ name }, dshHome, meta);
  const dataDirs = [];
  if (includeData) {
    for (const candidate of dataCandidates) {
      const size = await measure(candidate.path, { skipDirs: SKIP_DIRS, keepFile: skipFileKeep });
      dataDirs.push({ ...candidate, bytes: size.bytes, files: size.files });
    }
  }

  const bytes = mainSize.bytes + deps.reduce((sum, dep) => sum + dep.bytes, 0) + dataDirs.reduce((sum, data) => sum + data.bytes, 0);
  const fileCount = mainSize.files + deps.reduce((sum, dep) => sum + dep.files, 0) + dataDirs.reduce((sum, data) => sum + data.files, 0);

  if (!entry && meta) pluginWarnings.push('找不到入口文件，导入后可能加载失败');
  if (pluginWarnings.length) warnings.push(...pluginWarnings.map((text) => `${name}: ${text}`));

  return {
    name,
    version: meta?.version ?? '0.0.0',
    description: typeof meta?.description === 'string' ? meta.description : '',
    kind: meta ? 'package' : 'path',
    dir: item.dir,
    link: item.link,
    declaredName: item.declaredName,
    inBundles: item.inBundles,
    bundleIndex: item.bundleIndex,
    sources: [...item.sources],
    hasPatch: Boolean(meta?.dsh?.bundle?.patch) && isFile(path.join(item.dir, meta.dsh.bundle.patch)),
    patchRel: typeof meta?.dsh?.bundle?.patch === 'string' ? meta.dsh.bundle.patch : null,
    client: meta?.dsh?.client ?? null,
    entry,
    deps,
    patchRows: patchInfo.patchRows,
    insertRows: patchInfo.insertRows,
    dataCandidates: dataCandidates.map((candidate) => candidate.name),
    dataDirs,
    bytes,
    fileCount,
    warnings: pluginWarnings,
  };
}
