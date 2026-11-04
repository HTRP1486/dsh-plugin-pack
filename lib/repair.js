/**
 * 修复 profile 里「配置说有、磁盘上没有」的插件。
 *
 * 为什么需要：回滚会把 package.json 恢复成某份快照，那份快照可能声明了
 * 某个插件，而它的 node_modules 链接（甚至目录）已经在更早的回滚里被删掉。
 * 结果 dsh 启动时报：
 *
 *   cannot resolve profile bundle "dsh-pet" ... run 'dsh plugin install'
 *
 * 而点「卸载」又会触发 pnpm 安装（可能因为 store 版本不匹配直接失败）。
 *
 * 这里做的是把两边对齐：
 *   目录在、链接缺        → 补链接（插件能正常用）
 *   目录和链接都缺        → 从 dependencies / bundles 里移除（不留僵尸条目）
 *   官方包（@deepseek-ai/*）→ 从 dsh 安装目录解析，永远跳过
 *
 * @module dsh-plugin-pack/lib/repair
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson, ensureDir, isDir } from './util.js';
import { clearScanCache } from './scan.js';
import { syncLockfile } from './lockfile.js';

/** 这个包是不是宿主自带（从 dsh 安装目录解析）。 */
function isOfficial(name) {
  return String(name).startsWith('@deepseek-ai/');
}

/** 把 `link:./local-plugins/xxx` 里的目录段取出来；不是这种写法返回 null。 */
function localSegment(spec) {
  const text = String(spec ?? '');
  if (!text.startsWith('link:')) return null;
  const rel = text.slice('link:'.length).replace(/\\/g, '/');
  const match = /(?:^|\/)local-plugins\/([^/]+)\/?$/.exec(rel);
  return match ? match[1] : null;
}

/** node_modules 里这个包名的路径（scoped 要分两级）。 */
function linkPathOf(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...String(name).split('/'));
}

/** 指向目标目录建一个 junction / symlink。 */
function makeLink(linkPath, target) {
  ensureDir(path.dirname(linkPath));
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 对齐 profile 的声明与实际磁盘。
 *
 * @param {object} options
 * @param {string} options.profileDir
 * @param {boolean} [options.dryRun] 只算不改
 * @returns {{ ok: boolean, linked: string[], removed: string[], unlinked: string[], warnings: string[] }}
 */
export function repairProfile({ profileDir, dryRun = false }) {
  const profile = path.resolve(profileDir);
  const pkgFile = path.join(profile, 'package.json');
  const pkg = readJson(pkgFile, null);
  if (!pkg || typeof pkg !== 'object') {
    const error = new Error(`profile 里没有 package.json: ${pkgFile}`);
    error.code = 'BAD_PROFILE';
    throw error;
  }

  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  const linked = [];
  const removed = [];
  const unlinked = [];
  const warnings = [];

  const dropNames = new Set();

  for (const [name, spec] of Object.entries(pkg.dependencies)) {
    if (isOfficial(name)) continue; // 宿主自带，不碰
    const seg = localSegment(spec);
    if (!seg) continue; // 只处理本工具自己写的那种 link

    const dir = path.join(profile, 'local-plugins', seg);
    const linkPath = linkPathOf(profile, name);
    const dirOk = isDir(dir);
    const linkOk = fs.existsSync(linkPath);

    if (dirOk && !linkOk) {
      // 目录在、链接缺 → 补上，插件恢复可用
      if (!dryRun && makeLink(linkPath, dir)) linked.push(name);
      else if (dryRun) linked.push(name);
      else warnings.push(`补链接失败: ${name}`);
      continue;
    }

    if (!dirOk) {
      // 目录没了 → 不论链接在不在，这条声明都是僵尸
      if (linkOk) {
        if (!dryRun) {
          try {
            fs.unlinkSync(linkPath);
            unlinked.push(name);
          } catch {
            try {
              fs.rmSync(linkPath, { recursive: true, force: true });
              unlinked.push(name);
            } catch {
              /* 删不掉就留着，至少别写进删名单 */
            }
          }
        } else {
          unlinked.push(name);
        }
      }
      dropNames.add(name);
    }
  }

  if (dropNames.size) {
    for (const name of dropNames) {
      delete pkg.dependencies[name];
      removed.push(name);
    }
    pkg.dsh.profile.bundles = bundles.filter((name) => !dropNames.has(name));
  }

  if (!dryRun && (linked.length || removed.length)) {
    writeJson(pkgFile, pkg);
    // 配置和磁盘刚对齐，扫描缓存必须失效
    clearScanCache();
  }

  /* 删掉依赖之后锁文件也要跟上，否则 dsh 卸载/安装插件时会因为
   * ERR_PNPM_OUTDATED_LOCKFILE 失败。 */
  let lockfile = null;
  if (!dryRun && removed.length) {
    lockfile = syncLockfile(profile);
  }

  return { ok: true, linked, removed, unlinked: unlinked, warnings, lockfile };
}
