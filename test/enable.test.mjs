/**
 * 装完可以选「立即启用」或「不启用」。
 *
 * DSH 里"启用"就一件事：包名在 profile/package.json 的
 * dsh.profile.bundles 里。所以：
 *   启用   → 加进 bundles
 *   不启用 → 不进 bundles（文件与依赖照常写好）
 *
 * 停用不等于卸载：文件、依赖、node_modules 链接都不动，
 * 随时能再启用，不用重装。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { setPluginsEnabled, getEnabledState } from '../lib/enable.js';
import { importBundle } from '../lib/import.js';
import { exportBundle } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-enable');

/** 造一个空 profile。 */
function makeProfile(name = 'profile') {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'local-plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# empty\n');
  return dir;
}

const readBundles = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dsh.profile.bundles;

test('启用：把包名加进 bundles', () => {
  const dir = makeProfile('a');
  const result = setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: true });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.deepEqual(result.changed, [{ name: 'dsh-pet', from: false, to: true }]);
  assert.deepEqual(readBundles(dir), ['dsh-pet']);
});

test('停用：从 bundles 移除，但不删文件', () => {
  const dir = makeProfile('b');
  setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: true });
  // 造一个假的插件目录，确认停用后文件还在
  const pluginDir = path.join(dir, 'local-plugins', 'dsh-pet');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'package.json'), '{"name":"dsh-pet","version":"1.0.0"}');

  const result = setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: false });
  assert.equal(result.changed.length, 1);
  assert.deepEqual(readBundles(dir), []);
  assert.equal(fs.existsSync(pluginDir), true, '停用不是卸载，文件必须还在');
});

test('已经是目标状态 → 不做改动，changed 为空', () => {
  const dir = makeProfile('c');
  setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: true });

  const again = setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: true });
  assert.deepEqual(again.changed, []);
  assert.equal(again.restartRequired, false, '没变化就不需要重启');
});

test('批量：一次启用多个，保持原有顺序并追加', () => {
  const dir = makeProfile('d');
  setPluginsEnabled({ profileDir: dir, names: ['existing'], enabled: true });

  const result = setPluginsEnabled({ profileDir: dir, names: ['b-pet', 'c-pet'], enabled: true });
  assert.equal(result.changed.length, 2);
  assert.deepEqual(readBundles(dir), ['existing', 'b-pet', 'c-pet'], '先来的保持在前，新追加到末尾');
});

test('批量停用只移出指定的那些，其它不动', () => {
  const dir = makeProfile('e');
  setPluginsEnabled({ profileDir: dir, names: ['a', 'b', 'c'], enabled: true });

  setPluginsEnabled({ profileDir: dir, names: ['b'], enabled: false });
  assert.deepEqual(readBundles(dir), ['a', 'c']);
});

test('dryRun 只算不改盘', () => {
  const dir = makeProfile('f');
  const result = setPluginsEnabled({ profileDir: dir, names: ['dsh-pet'], enabled: true, dryRun: true });
  assert.equal(result.changed.length, 1);
  assert.deepEqual(result.bundles, ['dsh-pet'], '返回值里应该体现预期结果');
  assert.deepEqual(readBundles(dir), [], '但磁盘不该被改');
});

test('空名单 → 报 EMPTY_SELECTION', () => {
  const dir = makeProfile('g');
  assert.throws(() => setPluginsEnabled({ profileDir: dir, names: [], enabled: true }), /没有指定/);
});

test('profile 没有 package.json → 报 BAD_PROFILE', () => {
  const dir = path.join(TMP, 'no-pkg');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => setPluginsEnabled({ profileDir: dir, names: ['x'], enabled: true }), /package\.json/);
});

test('getEnabledState 能区分"装了但没启用"', () => {
  const dir = makeProfile('h');
  // 装一个：有依赖、有目录，但不在 bundles
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies['dsh-pet'] = 'link:./local-plugins/dsh-pet';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
  fs.mkdirSync(path.join(dir, 'local-plugins', 'dsh-pet'), { recursive: true });

  const state = getEnabledState(dir, ['dsh-pet', 'not-there']);
  assert.deepEqual(state[0], { name: 'dsh-pet', enabled: false, installed: true });
  assert.deepEqual(state[1], { name: 'not-there', enabled: false, installed: false });
});

test('导入时可以选 enable=false：装上但不进 bundles', async () => {
  const srcProfile = makeProfile('src');
  // 勾多个插件导出才是 .zip 整合包（单个插件导出的是 .tgz）
  const realBundle = await exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });
  assert.ok(realBundle.file.endsWith('.zip'), `应是整合包 zip，实际 ${realBundle.file}`);

  const target = makeProfile('target');
  const result = importBundle({ file: realBundle.file, profileDir: target, enable: false });

  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.deepEqual(readBundles(target), [], '不启用就不该进 bundles');
  assert.deepEqual(result.bundlesAdded, [], 'bundlesAdded 应为空');

  // 但文件与依赖确实写好了
  const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies['dsh-plugin-pack'], '依赖应已写入');
  assert.equal(fs.existsSync(path.join(target, 'local-plugins', 'dsh-plugin-pack')), true, '文件应已落地');
  assert.ok(result.disabledNames.includes('dsh-plugin-pack'), '应报出"装了但没启用"的名单');

  // 之后可以再启用
  const enabled = setPluginsEnabled({ profileDir: target, names: ['dsh-plugin-pack'], enabled: true });
  assert.equal(enabled.changed.length, 1);
  assert.deepEqual(readBundles(target), ['dsh-plugin-pack']);
});

test('默认行为不变：不传 enable 时仍然启用', async () => {
  const realBundle = await exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });
  const target = makeProfile('default-on');
  const result = importBundle({ file: realBundle.file, profileDir: target });
  assert.equal(result.enabled, true);
  assert.deepEqual(readBundles(target).sort(), ['dsh-one-click-polish', 'dsh-plugin-pack']);
});

test('界面源码：导入页有「安装后立即启用」勾选和启用/停用切换', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  assert.ok(src.includes('enable.onInstall'), '应有「安装后立即启用」勾选框');
  assert.ok(src.includes('installPrefs'), '应有偏好透传对象');
  assert.ok(/enable: installPrefs\.enable/.test(src), 'doImport 应带上 enable 选项');
  assert.ok(src.includes('rememberEnableState'), '装完应记住启用状态');
  assert.ok(src.includes('toggleEnabled'), '应有启用/停用切换');
  assert.ok(src.includes("'/plugin-pack/enable'"), '应调用启用接口');
  assert.ok(src.includes('enable.disabledHint'), '未启用时应有明确提示');
});
