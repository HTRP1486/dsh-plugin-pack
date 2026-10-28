/**
 * 客户端 bundle 热加载。
 *
 * 背景（读宿主 dsh-client-modules 源码得出的事实）：
 *
 *   1. 宿主启动时扫描 Loader 行 → 读 package.json → 判定 `dsh.client.platform === 'web'`
 *      且 `exports["./client"]` 存在 → 才把包入表，之后 `/plugins/??<id>/client.js&rev=<hash>` 才有内容。
 *   2. 判定结果（包括"不是客户端包"这种否定结论）缓存在 `pkgMeta: Map<sourceKey, meta|null>` 里，
 *      **没有任何失效机制** —— `resolveMeta()` 命中缓存就直接返回，从不重读 package.json。
 *      这就是为什么改了 package.json 也看不到界面，必须重启。
 *   3. 唯一能把改动送进图表的是 `rebuilt(id)`，但它只在 `table` 里已有这个包时才有效。
 *   4. `dirty: Set<entryName>` + `flush(onError)` 是重扫入口，`processOne` → `resolveSource`
 *      → `resolveMeta` 会**再走一次**判定 —— 只要把缓存删掉，重扫就会读到新值。
 *
 * 所以热加载 = 删缓存 + 标记 dirty + flush，再对已入表的包走 rebuilt。
 * 全部从宿主进程内部做，不需要重启。
 *
 * @module dsh-plugin-pack/hotload
 */
import fs from 'node:fs';
import path from 'node:path';

/** 宿主服务名。 */
const SERVICE = 'clientModules';

/**
 * 从 ctx 里取出 clientModules 服务实例。
 *
 * 优先 ctx.get()，其次直接取属性 —— 不同 cordis 版本暴露方式略有差别。
 *
 * @param {object} ctx
 * @returns {object|null}
 */
export function getRegistry(ctx) {
  if (!ctx) return null;
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get(SERVICE) : undefined;
    if (viaGet) return viaGet;
  } catch {
    /* 服务不存在时 cordis 会抛 */
  }
  try {
    const direct = ctx[SERVICE];
    if (direct) return direct;
  } catch {
    /* 需要 inject 才能取属性 */
  }
  return null;
}

/** 一个 Loader 行的 name 是否属于这个包。 */
function isRowOf(loaderName, packageName, packageDir) {
  if (loaderName === packageName) return true;
  // 路径形态的行（patch 里写死绝对路径的插件）
  const normalized = String(loaderName).replace(/\\/g, '/');
  const lowered = normalized.toLowerCase();
  const dir = String(packageDir).replace(/\\/g, '/').toLowerCase();
  if (!lowered.includes('/') && !lowered.includes(':')) return false;
  return lowered === dir || lowered.startsWith(`${dir}/`);
}

/**
 * 收集 registry 里所有和这个包相关的 sourceKey。
 *
 * pkgMeta 的 key 形如 `<baseUrl>\0<loaderName>`，所以要按 loaderName 匹配。
 *
 * @param {object} registry
 * @param {string} packageName
 * @param {string} packageDir
 * @returns {{ sourceKeys: string[], loaderNames: string[] }}
 */
export function keysForPackage(registry, packageName, packageDir) {
  const sourceKeys = [];
  const loaderNames = new Set();
  const meta = registry?.pkgMeta;
  if (!(meta instanceof Map)) return { sourceKeys, loaderNames };

  for (const key of meta.keys()) {
    const raw = String(key);
    const at = raw.indexOf('\0');
    const loaderName = at >= 0 ? raw.slice(at + 1) : raw;
    if (isRowOf(loaderName, packageName, packageDir)) {
      sourceKeys.push(key);
      loaderNames.add(loaderName);
    }
  }
  return { sourceKeys, loaderNames: [...loaderNames] };
}

/**
 * 让宿主重新扫描一个包，把改动送进客户端图表。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} options
 * @param {string} options.packageName 包名（Loader 行 name 常见取值）
 * @param {string} options.packageDir 包目录绝对路径（用于匹配路径形态的 Loader 行）
 * @param {(msg: string) => void} [options.log]
 * @returns {object} 结果
 */
export function reloadClientPackage(ctx, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const packageName = String(options.packageName ?? '').trim();
  const packageDir = String(options.packageDir ?? '').trim();
  if (!packageName) return { ok: false, error: '需要 packageName' };

  const registry = getRegistry(ctx);
  if (!registry) {
    return {
      ok: false,
      error: `宿主没有 ${SERVICE} 服务（可能不是 Web/桌面端，或版本不支持）`,
    };
  }

  const steps = [];
  const { sourceKeys, loaderNames } = keysForPackage(registry, packageName, packageDir);
  steps.push(`匹配到 ${sourceKeys.length} 条缓存 / ${loaderNames.length} 个 Loader 行`);

  // 1) 删掉否定缓存，让 resolveMeta 重读 package.json
  if (registry.pkgMeta instanceof Map) {
    for (const key of sourceKeys) registry.pkgMeta.delete(key);
    steps.push(`已清除 pkgMeta 缓存 ${sourceKeys.length} 条`);
  }

  // 2) 标记 dirty：processOne 会重新走 resolveSource → resolveMeta
  const names = loaderNames.length ? loaderNames : [packageName];
  if (!(registry.dirty instanceof Set)) {
    return { ok: false, error: 'registry.dirty 不是 Set，宿主版本不兼容' };
  }
  for (const name of names) registry.dirty.add(name);
  steps.push(`已标记 dirty: ${names.join(', ')}`);

  // 3) 触发重扫
  const failures = [];
  if (typeof registry.flush !== 'function') {
    return { ok: false, error: 'registry.flush 不可用，宿主版本不兼容' };
  }
  registry.flush((error) => failures.push(String(error?.message ?? error)));
  steps.push(`flush 完成，失败 ${failures.length} 条`);

  // 4) 若已入表，走 rebuilt 让浏览器拿到新 rev
  const inTable = registry.table instanceof Map ? registry.table.has(packageName) : false;
  let rev = null;
  if (inTable && typeof registry.rebuilt === 'function') {
    rev = registry.rebuilt(packageName) ?? null;
    steps.push(`rebuilt → rev=${rev}`);
  } else {
    steps.push('未入表（重扫可能失败，或 Loader 行不属于本包）');
  }

  for (const step of steps) log(step);

  return {
    ok: inTable,
    packageName,
    inTable,
    rev,
    clearedCaches: sourceKeys.length,
    loaderNames: names,
    failures,
    steps,
    error: inTable ? null : '重扫后仍不在图表里：检查 dsh.client.platform 是否为 web、exports["./client"] 是否存在、Loader 行 name 是否为包名',
  };
}

/**
 * 只读检查：这个包现在在宿主的客户端图表里吗？
 *
 * @param {object} ctx
 * @param {string} packageName
 * @returns {object}
 */
export function clientStatus(ctx, packageName) {
  const registry = getRegistry(ctx);
  if (!registry) return { available: false, reason: `没有 ${SERVICE} 服务` };
  const inTable = registry.table instanceof Map ? registry.table.has(packageName) : false;
  const record = inTable ? registry.table.get(packageName) : null;
  const composed = registry.composed ?? null;
  const rows = Array.isArray(composed?.entries) ? composed.entries : [];
  const row = rows.find((item) => item.id === packageName) ?? null;
  return {
    available: true,
    inTable,
    rev: record?.entry?.rev ?? row?.rev ?? null,
    clientPath: record?.meta?.clientPath ?? null,
    inject: record?.meta?.inject ?? null,
    immediately: record?.meta?.immediately ?? null,
    bootstrapIds: composed?.bootstrapIds ?? [],
    entries: rows.map((item) => item.id),
  };
}

/**
 * 直接读包自己的声明，判断"该不该"被宿主接受（不依赖宿主）。
 *
 * @param {string} packageDir
 * @returns {object}
 */
export function localVerdict(packageDir) {
  const pkgFile = path.join(packageDir, 'package.json');
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    return { ok: false, error: `读 package.json 失败: ${error?.message ?? error}` };
  }
  const decl = pkg.dsh?.client;
  if (!decl) return { ok: false, error: '没有 dsh.client 声明', name: pkg.name, version: pkg.version };
  if (decl.platform !== 'web') return { ok: false, error: `platform=${decl.platform}，需要 web`, name: pkg.name };

  let rel = pkg.exports?.['./client'];
  if (rel && typeof rel === 'object') rel = rel.default ?? rel.import ?? rel.require;
  if (typeof rel !== 'string') {
    return { ok: false, error: 'exports 里没有 "./client"', name: pkg.name };
  }
  const clientPath = path.join(packageDir, rel.replace(/^\.\//, ''));
  if (!fs.existsSync(clientPath)) {
    return { ok: false, error: `client bundle 不存在: ${clientPath}`, name: pkg.name };
  }
  const stat = fs.statSync(clientPath);
  return {
    ok: true,
    name: pkg.name,
    version: pkg.version,
    clientPath,
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
    inject: decl.inject ?? [],
    immediately: decl.immediately === true,
  };
}
