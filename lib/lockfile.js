/**
 * 同步 pnpm 锁文件。
 *
 * 为什么必须有这一步：我们改的是 `package.json` 的 dependencies，
 * 但 `pnpm-lock.yaml` 不会自己更新。而 dsh 的插件卸载/安装会跑
 *
 *   pnpm install --frozen-lockfile
 *
 * 锁文件一旦和 package.json 对不上，pnpm 直接抛
 *
 *   ERR_PNPM_OUTDATED_LOCKFILE
 *   specifiers in the lockfile don't match specifiers in package.json
 *
 * 表现就是：卸载按钮点了没反应、装新插件也失败。
 *
 * 所以导入/删除依赖之后，必须补一次 `pnpm install --lockfile-only`：
 * 只更新锁文件，不碰 node_modules，几秒就完。
 *
 * @module dsh-plugin-pack/lib/lockfile
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 找 pnpm 可执行文件；找不到返回 null。 */
function findPnpm() {
  const candidates =
    process.platform === 'win32'
      ? ['pnpm.cmd', 'pnpm.exe', 'pnpm']
      : ['pnpm'];

  for (const name of candidates) {
    const result = spawnSync(name, ['--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 15000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) return name;
  }
  return null;
}

/**
 * 让 `pnpm-lock.yaml` 与 `package.json` 对齐。
 *
 * 没有 package.json / 没有 pnpm / 没有 lockfile 时都不算错，直接跳过 ——
 * 这一步是"顺手修好别再踩坑"，不该阻断导入本身。
 *
 * @param {string} profileDir
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.force] 即使没有 lockfile 也生成一份
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, error?: string }}
 */
export function syncLockfile(profileDir, options = {}) {
  const profile = path.resolve(profileDir);
  const pkgFile = path.join(profile, 'package.json');
  const lockFile = path.join(profile, 'pnpm-lock.yaml');

  try {
    if (!fs.existsSync(pkgFile)) return { ok: false, skipped: true, reason: '没有 package.json' };
    // 本来就没有锁文件就别硬造一个（可能是 npm/yarn 项目）
    if (!fs.existsSync(lockFile) && !options.force) {
      return { ok: false, skipped: true, reason: '没有 pnpm-lock.yaml，跳过' };
    }

    const pnpm = findPnpm();
    if (!pnpm) return { ok: false, skipped: true, reason: '没找到 pnpm' };

    const result = spawnSync(pnpm, ['install', '--lockfile-only', '--reporter=silent'], {
      cwd: profile,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: options.timeoutMs ?? 120000,
      windowsHide: true,
      env: { ...process.env, CI: '' },
    });

    if (result.error) {
      return { ok: false, error: String(result.error.message ?? result.error) };
    }
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      return { ok: false, error: detail.slice(0, 400) || `pnpm 退出码 ${result.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 检查锁文件与 package.json 是否一致（不写盘）。
 *
 * @param {string} profileDir
 * @returns {{ ok: boolean, skipped?: boolean, outdated?: boolean, error?: string }}
 */
export function checkLockfile(profileDir) {
  const profile = path.resolve(profileDir);
  const pkgFile = path.join(profile, 'package.json');
  const lockFile = path.join(profile, 'pnpm-lock.yaml');

  try {
    if (!fs.existsSync(pkgFile) || !fs.existsSync(lockFile)) {
      return { ok: false, skipped: true };
    }
    const pnpm = findPnpm();
    if (!pnpm) return { ok: false, skipped: true, reason: '没找到 pnpm' };

    const result = spawnSync(pnpm, ['install', '--frozen-lockfile', '--lockfile-only'], {
      cwd: profile,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      timeout: 120000,
      windowsHide: true,
    });
    // 注意：这里不能用 --reporter=silent —— 它会把 ERR_PNPM_OUTDATED_LOCKFILE
    // 这段错误文本一起吞掉，导致分不清"锁文件不一致"和"其它失败"。
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/ERR_PNPM_OUTDATED_LOCKFILE/.test(detail)) return { ok: true, outdated: true };
    if (result.status === 0) return { ok: true, outdated: false };
    return { ok: false, error: detail.trim().slice(0, 400) || `pnpm 退出码 ${result.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
