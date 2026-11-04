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

/**
 * 找 pnpm —— 优先用 dsh 自带的那个。
 *
 * 为什么不能随便用 PATH 上的：dsh 内置 pnpm 11（store/v11），
 * 用户命令行可能是 pnpm 10（store/v10）。store 目录不同、锁文件格式也可能不同，
 * 用错版本去同步等于又把 dsh 的安装/卸载搞坏。
 *
 * 探测顺序：DSH_PNPM 环境变量 → dsh 运行时里的 pnpm.cjs → PATH 上的 pnpm。
 *
 * @returns {{ command: string, args: string[], version: string|null, bundled: boolean } | null}
 */
function findPnpm() {
  const candidates = [];

  if (process.env.DSH_PNPM && fs.existsSync(process.env.DSH_PNPM)) {
    candidates.push({ command: process.execPath, args: [process.env.DSH_PNPM], bundled: true });
  }

  // dsh 的 node 通常在 <runtime>/node.exe，pnpm 在 <runtime>/dependencies/pnpm/bin/pnpm.cjs
  const exeDir = path.dirname(process.execPath);
  for (const rel of [
    ['dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    ['..', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    ['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
  ]) {
    const candidate = path.join(exeDir, ...rel);
    if (fs.existsSync(candidate)) {
      candidates.push({ command: process.execPath, args: [candidate], bundled: true });
      break;
    }
  }

  // 兜底：PATH 上的 pnpm
  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm'];
  for (const name of names) candidates.push({ command: name, args: [], bundled: false });

  for (const candidate of candidates) {
    const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
      encoding: 'utf8',
      // 自带 pnpm 是 node 直接跑 .cjs，不需要 shell；PATH 上的需要
      shell: process.platform === 'win32' && !candidate.bundled,
      timeout: 20000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      const version = String(result.stdout ?? '').trim().split('\n')[0] || null;
      return { ...candidate, version };
    }
  }
  return null;
}

/** 用找到的 pnpm 跑一条命令。 */
function runPnpm(pnpm, args, cwd, timeoutMs) {
  return spawnSync(pnpm.command, [...pnpm.args, ...args], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32' && !pnpm.bundled,
    timeout: timeoutMs,
    windowsHide: true,
  });
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

    const result = runPnpm(
      pnpm,
      ['install', '--lockfile-only', '--config.confirmModulesPurge=false'],
      profile,
      options.timeoutMs ?? 180000,
    );

    if (result.error) {
      return { ok: false, error: String(result.error.message ?? result.error), pnpm: pnpm.version };
    }
    if (result.status !== 0) {
      const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
      return { ok: false, error: detail.slice(0, 400) || `pnpm 退出码 ${result.status}`, pnpm: pnpm.version };
    }
    return { ok: true, pnpm: pnpm.version };
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

    const result = runPnpm(pnpm, ['install', '--frozen-lockfile', '--lockfile-only'], profile, 180000);
    // 注意：这里不能用 --reporter=silent —— 它会把 ERR_PNPM_OUTDATED_LOCKFILE
    // 这段错误文本一起吞掉，导致分不清"锁文件不一致"和"其它失败"。
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (/ERR_PNPM_OUTDATED_LOCKFILE/.test(detail)) return { ok: true, outdated: true, pnpm: pnpm.version };
    if (result.status === 0) return { ok: true, outdated: false, pnpm: pnpm.version };
    // 其它错误里也可能带 store 不一致
    if (/ERR_PNPM_UNEXPECTED_STORE/.test(detail)) {
      return { ok: false, storeMismatch: true, pnpm: pnpm.version, error: detail.trim().slice(0, 400) };
    }
    return { ok: false, error: detail.trim().slice(0, 400) || `pnpm 退出码 ${result.status}`, pnpm: pnpm.version };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
