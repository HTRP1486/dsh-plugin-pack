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
 * 读 `node_modules/.modules.yaml` 里记录的 pnpm 版本（如 "pnpm@11.28.5"）。
 *
 * 用哪份 pnpm 建出来的 node_modules，就得用同大版本的 pnpm 去改锁文件 ——
 * 混用会把 store 路径和锁文件格式搞乱。
 *
 * @param {string} profileDir
 * @returns {{ major: number|null, packageManager: string|null }}
 */
function wantedPnpmVersion(profileDir) {
  try {
    const text = fs.readFileSync(path.join(profileDir, 'node_modules', '.modules.yaml'), 'utf8');
    const match = /"?packageManager"?\s*:\s*"?pnpm@(\d+)\.([\d.]+)"?/.exec(text);
    if (match) return { major: Number(match[1]), packageManager: `pnpm@${match[1]}.${match[2]}` };
  } catch {
    /* 没有 .modules.yaml */
  }
  return { major: null, packageManager: null };
}

/** 列候选 pnpm 命令（自带优先，PATH 兜底）。 */
function pnpmCandidates() {
  const list = [];

  if (process.env.DSH_PNPM && fs.existsSync(process.env.DSH_PNPM)) {
    list.push({ command: process.execPath, args: [process.env.DSH_PNPM], bundled: true });
  }

  // dsh 的 node 通常在 <runtime>/node.exe，pnpm 在 <runtime>/dependencies/pnpm/bin/pnpm.cjs
  const exeDir = path.dirname(process.execPath);
  for (const rel of [
    ['dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    ['..', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    ['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    ['..', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
    // Electron 布局：execPath 是 <AppDir>/xxx.exe，pnpm 在 <AppDir>/resources/...
    ['resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'],
  ]) {
    const candidate = path.join(exeDir, ...rel);
    if (fs.existsSync(candidate)) {
      list.push({ command: process.execPath, args: [candidate], bundled: true });
      break;
    }
  }

  const names = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm'];
  for (const name of names) list.push({ command: name, args: [], bundled: false });

  return list;
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
 * 找 pnpm —— 优先挑与 `.modules.yaml` 记录同大版本的那个。
 *
 * 为什么不能随便用 PATH 上的：dsh 内置 pnpm 11（store/v11），
 * 命令行可能是 pnpm 10（store/v10）。store 目录不同、锁文件格式也可能不同，
 * 用错版本去同步等于又把 dsh 的安装/卸载搞坏。
 *
 * @param {string} profileDir
 * @returns {{ command: string, args: string[], version: string|null, bundled: boolean, matched: boolean } | null}
 */
function findPnpm(profileDir) {
  const { major: want } = wantedPnpmVersion(profileDir);
  const candidates = pnpmCandidates();
  let fallback = null;

  for (const candidate of candidates) {
    const result = runPnpm(candidate, ['--version'], process.cwd(), 20000);
    if (result.error || result.status !== 0) continue;
    const version = String(result.stdout ?? '').trim().split('\n')[0] || null;
    if (!version) continue;

    const major = Number.parseInt(version.split('.')[0], 10);
    const resolved = { ...candidate, version, matched: want !== null && major === want };
    if (resolved.matched) return resolved;
    if (!fallback) fallback = resolved;
  }

  return fallback;
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

    const pnpm = findPnpm(profile);
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
    return { ok: true, pnpm: pnpm.version, pnpmMatched: pnpm.matched };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 快速判断锁文件是否与 package.json 脱节（纯文本解析，不起 pnpm 进程）。
 *
 * 为什么要这个：dsh 卸载插件时会先改 package.json、再跑 pnpm；
 * 一旦 pnpm 失败，两边就不一致了，之后每次卸载都会失败。
 * 解析只要几毫秒，可以在 status 里顺手查，发现问题后台自动修。
 *
 * @param {string} profileDir
 * @returns {{ ok: boolean, outdated: boolean, missing: string[], extra: string[], changed: string[] }}
 */
export function lockfileStatus(profileDir) {
  const profile = path.resolve(profileDir);
  const empty = { ok: false, outdated: false, missing: [], extra: [], changed: [] };

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
    const lockText = fs.readFileSync(path.join(profile, 'pnpm-lock.yaml'), 'utf8');

    const wanted = {};
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const block = pkg?.[field];
      if (block && typeof block === 'object') {
        for (const [name, spec] of Object.entries(block)) wanted[name] = String(spec);
      }
    }

    /* 只解析 importers 下 "." 那一段，取每个依赖的 specifier。
     * 够用即可 —— 完整 YAML 解析不必要，也不该为此引依赖。 */
    const locked = {};
    const lines = lockText.split(/\r?\n/);
    let inImporters = false;
    let inRoot = false;
    let inDeps = false;
    let currentName = null;

    for (const line of lines) {
      if (/^importers:\s*$/.test(line)) {
        inImporters = true;
        continue;
      }
      if (!inImporters) continue;
      // 顶格的非 importers 行 = 出了这一段
      if (/^\S/.test(line)) break;

      if (/^ {2}\.:\s*$/.test(line)) {
        inRoot = true;
        inDeps = false;
        continue;
      }
      if (!inRoot) continue;
      // 另一个 importer（同缩进 2 格）→ 结束
      if (/^ {2}\S/.test(line)) break;

      if (/^ {4}(dependencies|devDependencies|optionalDependencies):\s*$/.test(line)) {
        inDeps = true;
        currentName = null;
        continue;
      }
      // 同层其它键（比如 specifiers:）→ 离开依赖段
      if (/^ {4}\S/.test(line)) {
        inDeps = false;
        currentName = null;
        continue;
      }
      if (!inDeps) continue;

      const nameMatch = /^ {6}(\S.*?):\s*$/.exec(line);
      if (nameMatch) {
        currentName = nameMatch[1].replace(/^['"]|['"]$/g, '');
        continue;
      }
      const specMatch = /^ {8}specifier:\s*(.+?)\s*$/.exec(line);
      if (specMatch && currentName) {
        locked[currentName] = specMatch[1].replace(/^['"]|['"]$/g, '');
        currentName = null;
      }
    }

    const missing = Object.keys(wanted).filter((name) => !(name in locked));
    const extra = Object.keys(locked).filter((name) => !(name in wanted));
    const changed = Object.keys(wanted).filter(
      (name) => name in locked && locked[name] !== null && locked[name] !== wanted[name],
    );

    return {
      ok: true,
      outdated: missing.length > 0 || extra.length > 0 || changed.length > 0,
      missing,
      extra,
      changed,
    };
  } catch {
    return empty;
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
    const pnpm = findPnpm(profile);
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
