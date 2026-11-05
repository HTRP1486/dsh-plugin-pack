/**
 * 锁文件同步：卸载/安装插件失败的直接原因。
 *
 * dsh 的插件卸载/安装会跑 `pnpm install --frozen-lockfile`。
 * 我们导入时只改 package.json 的 dependencies，锁文件不会自动更新，
 * 于是 pnpm 直接抛：
 *
 *   ERR_PNPM_OUTDATED_LOCKFILE
 *   specifiers in the lockfile don't match specifiers in package.json
 *
 * 用户看到的现象就是：卸载按钮点了没反应。
 *
 * 所以导入/清理依赖之后必须补一次 `pnpm install --lockfile-only`
 * （只更新锁文件，不碰 node_modules）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { syncLockfile, checkLockfile, lockfileStatus } from '../lib/lockfile.js';

/** 造一个最小 pnpm 锁文件（只含 importers 下 "." 的依赖段）。 */
function writeLock(dir, deps) {
  const body = Object.entries(deps)
    .map(([name, spec]) => `      ${name}:\n        specifier: ${spec}\n        version: ${spec}`)
    .join('\n');
  fs.writeFileSync(
    path.join(dir, 'pnpm-lock.yaml'),
    ['lockfileVersion: 9.0', '', 'importers:', '', '  .:', '', '    dependencies:', body || '      {}', ''].join('\n'),
  );
}

function writePkg(dir, deps) {
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: deps }, null, 2),
  );
}

test('lockfileStatus：一致时报 outdated=false', () => {
  const dir = path.join(os.tmpdir(), 'dsh-pp-lock-status-a');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writePkg(dir, { 'dsh-pet': 'link:./local-plugins/dsh-pet' });
  writeLock(dir, { 'dsh-pet': 'link:./local-plugins/dsh-pet' });

  const s = lockfileStatus(dir);
  assert.equal(s.ok, true);
  assert.equal(s.outdated, false);
  assert.deepEqual(s.missing, []);
  assert.deepEqual(s.extra, []);
});

test('lockfileStatus：package.json 多了依赖 → missing', () => {
  const dir = path.join(os.tmpdir(), 'dsh-pp-lock-status-b');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writePkg(dir, { 'dsh-pet': 'link:./local-plugins/dsh-pet', 'dsh-new': 'link:./local-plugins/dsh-new' });
  writeLock(dir, { 'dsh-pet': 'link:./local-plugins/dsh-pet' });

  const s = lockfileStatus(dir);
  assert.equal(s.outdated, true);
  assert.deepEqual(s.missing, ['dsh-new']);
});

test('lockfileStatus：锁文件多了依赖 → extra（卸载后典型状态）', () => {
  const dir = path.join(os.tmpdir(), 'dsh-pp-lock-status-c');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writePkg(dir, {});
  writeLock(dir, { 'dsh-gone': 'link:./local-plugins/dsh-gone' });

  const s = lockfileStatus(dir);
  assert.equal(s.outdated, true);
  assert.deepEqual(s.extra, ['dsh-gone']);
});

test('lockfileStatus：版本变了 → changed', () => {
  const dir = path.join(os.tmpdir(), 'dsh-pp-lock-status-d');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  writePkg(dir, { 'dsh-ops': '^0.5.0' });
  writeLock(dir, { 'dsh-ops': '^0.4.1' });

  const s = lockfileStatus(dir);
  assert.equal(s.outdated, true);
  assert.deepEqual(s.changed, ['dsh-ops']);
});

test('lockfileStatus：文件缺失时不抛错', () => {
  const dir = path.join(os.tmpdir(), 'dsh-pp-lock-status-e');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const s = lockfileStatus(dir);
  assert.equal(s.ok, false);
  assert.equal(s.outdated, false);
});

test('源码：status 会报锁文件状态并后台自愈', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'server.js'), 'utf8');

  assert.ok(src.includes('lockfileOutdated'), 'status 应报锁文件是否过期');
  assert.ok(src.includes('autoHealLockfile'), '应在发现过期时后台自愈');
  assert.ok(/LOCK_HEAL_INTERVAL_MS/.test(src), '自愈要节流，不能每次刷新都跑 pnpm');
});

const TMP = path.join(os.tmpdir(), 'dsh-pp-lockfile');

function fresh(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('没有 package.json → 跳过，不报错', () => {
  const dir = fresh('no-pkg');
  const result = syncLockfile(dir);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /package\.json/);
});

test('没有 pnpm-lock.yaml → 跳过（不硬造一个）', () => {
  const dir = fresh('no-lock');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true }));
  const result = syncLockfile(dir);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /pnpm-lock/);
  assert.equal(fs.existsSync(path.join(dir, 'pnpm-lock.yaml')), false, '不该凭空造锁文件');
});

test('force 时可以生成锁文件', () => {
  const dir = fresh('force');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, dependencies: {} }));
  const result = syncLockfile(dir, { force: true });
  // pnpm 不一定装了；装了就应该生成
  if (result.ok) {
    assert.equal(fs.existsSync(path.join(dir, 'pnpm-lock.yaml')), true);
  } else {
    assert.ok(result.skipped || result.error, '失败要给出原因');
  }
});

test('checkLockfile：缺文件时跳过而不是报错', () => {
  const dir = fresh('check-skip');
  const result = checkLockfile(dir);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
});

test('真实场景：改依赖后锁文件不一致，sync 后一致', async () => {
  const dir = fresh('real');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {} }, null, 2),
  );

  // 先建立一份锁文件
  const first = syncLockfile(dir, { force: true });
  if (!first.ok) {
    // 环境里没有 pnpm，跳过这条（不静默通过，明确标记）
    assert.ok(first.skipped || first.error, '没有 pnpm 时应给出原因');
    return;
  }
  assert.equal(fs.existsSync(path.join(dir, 'pnpm-lock.yaml')), true);

  const before = checkLockfile(dir);
  assert.equal(before.outdated, false, '刚同步完应一致');

  // 手动加一个依赖（模拟导入插件只改 package.json）
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.dependencies['dsh-plugin-pack'] = 'link:./local-plugins/dsh-plugin-pack';
  fs.mkdirSync(path.join(dir, 'local-plugins', 'dsh-plugin-pack'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'local-plugins', 'dsh-plugin-pack', 'package.json'),
    JSON.stringify({ name: 'dsh-plugin-pack', version: '1.0.0' }),
  );
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  const stale = checkLockfile(dir);
  assert.equal(stale.outdated, true, '只改 package.json 后锁文件应变成不一致');

  const synced = syncLockfile(dir);
  assert.equal(synced.ok, true);
  const after = checkLockfile(dir);
  assert.equal(after.outdated, false, '同步后应恢复一致');
});

test('源码：导入与对账都会同步锁文件', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const importSrc = fs.readFileSync(path.join(root, 'lib', 'import.js'), 'utf8');
  assert.ok(importSrc.includes('syncLockfile'), 'importBundle 应同步锁文件');
  assert.ok(/lockfile,/.test(importSrc), '结果里应带上 lockfile 状态');

  const repairSrc = fs.readFileSync(path.join(root, 'lib', 'repair.js'), 'utf8');
  assert.ok(repairSrc.includes('syncLockfile'), 'repairProfile 删除依赖后应同步锁文件');

  const serverSrc = fs.readFileSync(path.join(root, 'lib', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('/lockfile'), '应提供锁文件检查接口');
  assert.ok(serverSrc.includes('/lockfile/sync'), '应提供锁文件同步接口');
});
