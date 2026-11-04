/**
 * 启用 / 停用已安装的插件。
 *
 * DSH 里"启用"的判定很简单：包名在 `profile/package.json` 的
 * `dsh.profile.bundles` 数组里，启动时就会被加载；不在就不加载。
 *
 * 所以启用 = 加进 bundles，停用 = 从 bundles 移出。
 * 文件、依赖、node_modules 链接都不动 —— 停用不是卸载，
 * 用户随时可以再启用，不用重新装一遍。
 *
 * @module dsh-plugin-pack/lib/enable
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './util.js';
import { clearScanCache } from './scan.js';

/** 读 profile 的 package.json（缺字段时补齐，但不写盘）。 */
function loadPkg(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = readJson(pkgFile, null);
  if (!pkg || typeof pkg !== 'object') {
    const error = new Error(`profile 里没有 package.json: ${pkgFile}`);
    error.code = 'BAD_PROFILE';
    throw error;
  }
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  if (!Array.isArray(pkg.dsh.profile.bundles)) pkg.dsh.profile.bundles = [];
  return { pkg, pkgFile };
}

/**
 * 读取一批插件当前的启用状态。
 *
 * @param {string} profileDir
 * @param {string[]} names
 * @returns {Array<{ name: string, enabled: boolean, installed: boolean }>}
 */
export function getEnabledState(profileDir, names) {
  const { pkg } = loadPkg(profileDir);
  const bundles = new Set(pkg.dsh.profile.bundles);
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const localPluginsDir = path.join(profileDir, 'local-plugins');

  return names.map((name) => {
    const segments = String(name).split('/');
    const inLocalPlugins =
      segments.length === 1 && fs.existsSync(path.join(localPluginsDir, name));
    return {
      name,
      enabled: bundles.has(name),
      // 装了（在依赖里或 local-plugins 里有目录）但可能没启用
      installed: Boolean(deps[name]) || inLocalPlugins || bundles.has(name),
    };
  });
}

/**
 * 批量启用或停用。
 *
 * @param {object} options
 * @param {string} options.profileDir
 * @param {string[]} options.names 插件包名
 * @param {boolean} options.enabled true=启用（加入 bundles），false=停用（移出）
 * @param {boolean} [options.dryRun]
 * @returns {{ ok: boolean, enabled: boolean, changed: Array<{name: string, from: boolean, to: boolean}>, bundles: string[], restartRequired: boolean }}
 */
export function setPluginsEnabled({ profileDir, names, enabled, dryRun = false }) {
  const profile = path.resolve(profileDir);
  const list = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name.trim()) : [];
  if (!list.length) {
    const error = new Error('没有指定要启用/停用的插件');
    error.code = 'EMPTY_SELECTION';
    throw error;
  }

  const { pkg, pkgFile } = loadPkg(profile);
  const before = new Set(pkg.dsh.profile.bundles);
  const changed = [];

  for (const name of list) {
    const from = before.has(name);
    if (from === enabled) continue; // 已经是目标状态，不动
    changed.push({ name, from, to: enabled });
    if (enabled) before.add(name);
    else before.delete(name);
  }

  // bundles 保持原顺序，新增的追加到末尾；停用的直接消失
  const nextBundles = pkg.dsh.profile.bundles.filter((name) => before.has(name));
  for (const item of changed) {
    if (item.to && !nextBundles.includes(item.name)) nextBundles.push(item.name);
  }

  if (!dryRun && changed.length) {
    pkg.dsh.profile.bundles = nextBundles;
    writeJson(pkgFile, pkg);
    // 配置变了，扫描缓存要失效，否则界面还按旧状态显示
    clearScanCache();
  }

  return {
    ok: true,
    enabled: Boolean(enabled),
    changed,
    bundles: nextBundles,
    restartRequired: changed.length > 0,
  };
}
