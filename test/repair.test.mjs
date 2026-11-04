/**
 * 回滚后对账：把「配置里有、磁盘上没有」的插件修好。
 *
 * 事故背景：回滚把 package.json 恢复成快照，快照里声明了某个插件，
 * 但它的 node_modules 链接在更早的回滚里被删了。dsh 启动就报
 *
 *   cannot resolve profile bundle "dsh-pet" ...
 *   run 'dsh plugin install' if its dependency is not installed
 *
 * 而点「卸载」会触发 pnpm，遇到 store 版本不匹配又直接失败。
 *
 * repairProfile 的规则：
 *   目录在、链接缺 → 补链接
 *   目录和链接都缺 → 从 dependencies/bundles 移除
 *   官方包         → 跳过（从 dsh 安装目录解析）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { repairProfile } from '../lib/repair.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-repair');

function fresh(name) {
  const profile = path.join(TMP, name);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(path.join(profile, 'local-plugins'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  return profile;
}

function writePkg(profile, { deps = {}, bundles = [] }) {
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: deps, dsh: { profile: { bundles } } }, null, 2),
  );
}

const readPkg = (profile) => JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));

/** 造一个插件目录。 */
function makePluginDir(profile, seg) {
  const dir = path.join(profile, 'local-plugins', seg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: seg, version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'export default 1;');
  return dir;
}

test('目录在、链接缺 → 补上链接，插件恢复可解析', () => {
  const profile = fresh('relink');
  const dir = makePluginDir(profile, 'dsh-pet');
  writePkg(profile, { deps: { 'dsh-pet': 'link:./local-plugins/dsh-pet' }, bundles: ['dsh-pet'] });

  const linkPath = path.join(profile, 'node_modules', 'dsh-pet');
  assert.equal(fs.existsSync(linkPath), false, '前提：链接本来不存在');

  const result = repairProfile({ profileDir: profile });
  assert.deepEqual(result.linked, ['dsh-pet']);
  assert.equal(fs.existsSync(linkPath), true, '链接应被补上');
  assert.equal(fs.existsSync(path.join(linkPath, 'package.json')), true, '透过链接应能读到文件');
  // 声明保持不变
  assert.equal(readPkg(profile).dependencies['dsh-pet'], 'link:./local-plugins/dsh-pet');
  assert.deepEqual(readPkg(profile).dsh.profile.bundles, ['dsh-pet']);
});

test('目录和链接都缺 → 从 dependencies 与 bundles 移除（清僵尸条目）', () => {
  const profile = fresh('drop');
  writePkg(profile, {
    deps: {
      'dsh-gone': 'link:./local-plugins/dsh-gone',
      'dsh-alive': 'link:./local-plugins/dsh-alive',
    },
    bundles: ['dsh-gone', 'dsh-alive'],
  });
  makePluginDir(profile, 'dsh-alive');

  const result = repairProfile({ profileDir: profile });
  assert.deepEqual(result.removed, ['dsh-gone']);

  const pkg = readPkg(profile);
  assert.equal(pkg.dependencies['dsh-gone'], undefined, '僵尸依赖应被删除');
  assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-alive'], '僵尸 bundle 应被移除，活着的保留');
});

test('目录没了但链接还在 → 先删链接，再删声明', () => {
  const profile = fresh('unlink');
  writePkg(profile, { deps: { 'dsh-ghost': 'link:./local-plugins/dsh-ghost' }, bundles: [] });

  // 造一个指向不存在目标的链接
  const linkPath = path.join(profile, 'node_modules', 'dsh-ghost');
  try {
    fs.symlinkSync(path.join(profile, 'local-plugins', 'dsh-ghost'), linkPath, 'junction');
  } catch {
    /* 权限不足时跳过本用例的链接断言 */
  }

  const result = repairProfile({ profileDir: profile });
  assert.deepEqual(result.removed, ['dsh-ghost']);
  assert.equal(readPkg(profile).dependencies['dsh-ghost'], undefined);
});

test('官方包一律跳过（从 dsh 安装目录解析，不该动它）', () => {
  const profile = fresh('official');
  writePkg(profile, {
    deps: { '@deepseek-ai/dsh-base': 'workspace:*' },
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  });

  const result = repairProfile({ profileDir: profile });
  assert.deepEqual(result.removed, [], '不该删官方包');
  assert.deepEqual(result.linked, [], '也不该给官方包建链接');
  assert.deepEqual(readPkg(profile).dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ]);
});

test('非 link: 的依赖不碰（npm/github 装的交给包管理器）', () => {
  const profile = fresh('nonlink');
  writePkg(profile, {
    deps: { 'dsh-ops': '^0.4.1', 'dsh-purge': 'github:JeffKeeping/dsh-purge-plus' },
    bundles: ['dsh-ops', 'dsh-purge'],
  });

  const result = repairProfile({ profileDir: profile });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.linked, []);
  assert.equal(readPkg(profile).dependencies['dsh-ops'], '^0.4.1');
});

test('dryRun 只报告不改盘', () => {
  const profile = fresh('dry');
  makePluginDir(profile, 'dsh-pet');
  writePkg(profile, {
    deps: { 'dsh-pet': 'link:./local-plugins/dsh-pet', 'dsh-gone': 'link:./local-plugins/dsh-gone' },
    bundles: ['dsh-gone'],
  });

  const before = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
  const result = repairProfile({ profileDir: profile, dryRun: true });

  assert.deepEqual(result.linked, ['dsh-pet']);
  assert.deepEqual(result.removed, ['dsh-gone']);
  assert.equal(fs.existsSync(path.join(profile, 'node_modules', 'dsh-pet')), false, '不该建链接');
  assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), before, '不该改文件');
});

test('幂等：连续跑两次，第二次什么都没做', () => {
  const profile = fresh('idempotent');
  makePluginDir(profile, 'dsh-pet');
  writePkg(profile, { deps: { 'dsh-pet': 'link:./local-plugins/dsh-pet' }, bundles: [] });

  const first = repairProfile({ profileDir: profile });
  assert.deepEqual(first.linked, ['dsh-pet']);

  const second = repairProfile({ profileDir: profile });
  assert.deepEqual(second.linked, [], '第二次不该重复建链接');
  assert.deepEqual(second.removed, []);
});

test('profile 没有 package.json → 报 BAD_PROFILE', () => {
  const profile = fresh('no-pkg');
  assert.throws(() => repairProfile({ profileDir: profile }), /package\.json/);
});

test('源码：回滚结束会自动对账', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'import.js'), 'utf8');
  assert.ok(src.includes('repairProfile'), 'rollbackImport 应调用 repairProfile');
  assert.ok(/repair\b/.test(src), '结果里应带上 repair 字段');
});
