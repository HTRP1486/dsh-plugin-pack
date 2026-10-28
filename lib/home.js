/**
 * 路径与运行环境解析。
 *
 * dsh 在运行时注入 DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR，
 * 但 CLI 直接跑时这些变量可能不存在，所以要有和宿主一致的兜底。
 *
 * @module dsh-plugin-pack/home
 */
import os from 'node:os';
import path from 'node:path';

/** DSH 主目录。 */
export function dshHome(env = process.env) {
  const raw = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.dsh');
}

/** 当前 profile 名。 */
export function profileName(env = process.env) {
  const raw = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
  return raw || 'desktop';
}

/** 当前 profile 目录。 */
export function profileDir(env = process.env) {
  const raw = typeof env.DSH_PROFILE_DIR === 'string' ? env.DSH_PROFILE_DIR.trim() : '';
  return raw ? path.resolve(raw) : path.join(dshHome(env), 'profiles', profileName(env));
}

/** 把任意包名/目录名变成可安全落进 zip 的段名。 */
export function safeSegment(value) {
  const text = String(value ?? '').trim();
  const cleaned = text
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/\.\./g, '__');
  return cleaned || 'plugin';
}

/**
 * 包名 → 单层目录名。scoped 包（@local/x）会被压成 `@local__x`，
 * 这样 zip 里的 `packages/<段>/` 永远只有一层，解包不会踩到路径歧义。
 */
export function packSegment(name) {
  return safeSegment(String(name ?? '').replace(/\//g, '__'));
}

/** `20261026-145723` 形式的时间戳。 */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/** 人类可读体积。 */
export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
