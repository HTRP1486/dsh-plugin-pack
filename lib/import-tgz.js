/**
 * 导入 npm tarball（.tgz）：单插件包的解包与落地。
 *
 * 和整合包（zip）的区别：
 *   - 整合包 = 多个插件 + 依赖 + 配置，由本插件自己的 importBundle 还原
 *   - tarball = 一个标准 npm 包，政策上解包到 package/ 目录后，
 *     直接交给 importLocalPlugin 走"本地插件导入"那套
 *
 * @module dsh-plugin-pack/import-tgz
 */
import fs from 'node:fs';
import path from 'node:path';

import { readTgz } from './tar.js';
import { ensureDir, removeTree } from './util.js';
import { stamp } from './home.js';
import { importLocalPlugin } from './import-plugin.js';

/** 是不是 tarball。 */
export function isTarball(file) {
  const lower = String(file ?? '').toLowerCase();
  return lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
}

/**
 * 把一个 .tgz 解包到临时目录，返回包根目录。
 *
 * npm tarball 的内容都在 `package/` 下；如果解出来没有这一层（手搓的包），
 * 就把解包目录本身当包根，尽量兼容。
 *
 * @param {object} options
 * @param {string} options.file tarball 路径
 * @param {string} options.home $DSH_HOME（解包到 inbox 下）
 * @returns {{ dir: string, files: number, bytes: number, hasPackagePrefix: boolean }}
 */
export function unpackTarball({ file, home }) {
  const buffer = fs.readFileSync(file);
  const items = readTgz(buffer);
  if (!items.length) {
    const error = new Error('tarball 里没有文件');
    error.code = 'BAD_PACK';
    throw error;
  }

  const hasPackagePrefix = items.every((item) => item.name.startsWith('package/'));
  const root = path.join(home, 'plugin-pack', 'inbox', stamp(), 'unpacked');
  ensureDir(root);
  const base = path.resolve(root);

  let bytes = 0;
  let count = 0;
  for (const item of items) {
    // 去掉 package/ 前缀（有的话）；同时防穿越
    let rel = item.name.replace(/\\/g, '/');
    if (hasPackagePrefix) rel = rel.slice('package/'.length);
    rel = rel.replace(/^\/+/, '');
    if (!rel) continue;
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '..' || seg === '.')) continue;
    const target = path.join(base, ...segments);
    if (!path.resolve(target).startsWith(base)) continue;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, item.data);
    bytes += item.data.length;
    count += 1;
  }

  return { dir: root, files: count, bytes, hasPackagePrefix };
}

/**
 * 导入一个 npm tarball 作为本地插件。
 *
 * @param {object} options
 * @param {string} options.file tarball 路径
 * @param {string} options.home $DSH_HOME
 * @param {string} options.profileDir profile 目录
 * @param {boolean} [options.dryRun]
 * @param {'merge'|'skip'} [options.mode]
 * @returns {object}
 */
export function importTarball(options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  onProgress('解包 tarball', 10);
  const unpacked = unpackTarball({ file: options.file, home: options.home });
  onProgress(`解出 ${unpacked.files} 个文件，开始落地`, 40);

  const pkgFile = path.join(unpacked.dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    const error = new Error(`tarball 里没有 package.json，不是有效的插件包：${unpacked.dir}`);
    error.code = 'BAD_PLUGIN';
    // 清掉半成品
    removeTree(path.dirname(unpacked.dir));
    throw error;
  }

  const result = importLocalPlugin({
    dir: unpacked.dir,
    profileDir: options.profileDir,
    dryRun: Boolean(options.dryRun),
    mode: options.mode === 'skip' ? 'skip' : 'merge',
    // 单个插件也可能重名，同样支持逐插件决策
    decisions: options.decisions && typeof options.decisions === 'object' ? options.decisions : {},
    onProgress,
    // 关键：tgz 里的 node_modules 是插件的真实依赖，必须一起搬过去。
    // 漏了这一项会导致插件加载时报 ERR_MODULE_NOT_FOUND（dsh-pet 的 @electron/get 事故）。
    keepNodeModules: true,
  });

  return {
    ...result,
    fromTarball: true,
    unpacked: { dir: unpacked.dir, files: unpacked.files, bytes: unpacked.bytes },
  };
}
