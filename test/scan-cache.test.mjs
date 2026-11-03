/**
 * 「加载插件慢」和「装完了却显示未安装」两个问题的回归测试。
 *
 * 根因分别是：
 *   1. 慢：每次 status 都全量 stat 上万个文件（dsh-ops 一个插件就 9920 个）
 *   2. 显示未安装：本地插件导入没清扫描缓存；且缓存的有效性只看
 *      package.json/cordis.patch.yml 的 mtime，插件目录变化不触发失效
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { clearScanCache, clearSizeCache, scanProfile } from '../lib/scan.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-scan-cache');

/** 造一个最小可用的 profile：一个插件 + 必要的配置。 */
function makeProfile({ pluginName = 'dsh-demo', version = '1.0.0' } = {}) {
  fs.rmSync(TMP, { recursive: true, force: true });
  const profile = path.join(TMP, 'profile');
  const home = path.join(TMP, 'home');
  fs.mkdirSync(path.join(profile, 'local-plugins', pluginName), { recursive: true });
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const pluginDir = path.join(profile, 'local-plugins', pluginName);
  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({ name: pluginName, version, main: 'index.js' }),
  );
  fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default 1;');
  fs.writeFileSync(path.join(pluginDir, 'client.js'), 'module.exports = {};');

  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'p',
        private: true,
        dependencies: { [pluginName]: `link:./local-plugins/${pluginName}` },
        dsh: { profile: { bundles: [pluginName] } },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), `- id: ${pluginName}\n  name: ${pluginName}\n`);

  return { profile, home };
}

test('同一配置下第二次扫描命中缓存（毫秒级）', async () => {
  const { profile, home } = makeProfile();
  clearScanCache();
  clearSizeCache();

  const t1 = Date.now();
  const first = await scanProfile({ profileDir: profile, dshHome: home });
  const cold = Date.now() - t1;

  const t2 = Date.now();
  const second = await scanProfile({ profileDir: profile, dshHome: home });
  const warm = Date.now() - t2;

  assert.equal(second.plugins.length, first.plugins.length);
  assert.ok(warm <= cold + 5, `第二次不该更慢：冷 ${cold}ms / 热 ${warm}ms`);
  assert.ok(warm < 200, `命中缓存应该很快，实际 ${warm}ms`);
});

test('往 local-plugins 里新增插件目录 → 缓存自动失效并能看见新插件', async () => {
  const { profile, home } = makeProfile();
  clearScanCache();
  clearSizeCache();

  const before = await scanProfile({ profileDir: profile, dshHome: home });
  assert.equal(before.plugins.length, 1);

  // 模拟"装了一个新插件"：只加目录，不动 package.json
  const newDir = path.join(profile, 'local-plugins', 'dsh-newcomer');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'package.json'), JSON.stringify({ name: 'dsh-newcomer', version: '2.0.0' }));
  fs.writeFileSync(path.join(newDir, 'index.js'), 'export default 2;');

  // 关键：不清缓存也应该能发现 —— 靠 local-plugins 目录 mtime 失效
  const after = await scanProfile({ profileDir: profile, dshHome: home });
  const names = after.plugins.map((p) => p.name);
  assert.ok(names.includes('dsh-newcomer'), `应看到新插件，实际 ${JSON.stringify(names)}`);
});

test('clearScanCache 后立刻能读到最新状态（装完刷新的路径）', async () => {
  const { profile, home } = makeProfile();
  clearScanCache();
  clearSizeCache();

  await scanProfile({ profileDir: profile, dshHome: home });

  const dir = path.join(profile, 'local-plugins', 'dsh-demo');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'dsh-demo', version: '9.9.9' }));

  clearScanCache();
  const fresh = await scanProfile({ profileDir: profile, dshHome: home });
  const demo = fresh.plugins.find((p) => p.name === 'dsh-demo');
  assert.equal(demo.version, '9.9.9', '清缓存后应读到新版本号');
});

test('清扫描缓存不清体积缓存：装完插件后刷新仍然快', async () => {
  const { profile, home } = makeProfile();
  clearScanCache();
  clearSizeCache();

  // 先跑一次把体积缓存填上
  const t1 = Date.now();
  await scanProfile({ profileDir: profile, dshHome: home });
  const firstRun = Date.now() - t1;

  // 模拟装完插件：只清扫描结果缓存（install 里就是这么做的）
  clearScanCache();

  const t2 = Date.now();
  await scanProfile({ profileDir: profile, dshHome: home });
  const afterInstall = Date.now() - t2;

  assert.ok(
    afterInstall <= firstRun + 20,
    `装完刷新不该比首次更慢：首次 ${firstRun}ms / 装完 ${afterInstall}ms`,
  );
});

test('fresh=true 时跳过缓存，重新计算（导出要精确体积）', async () => {
  const { profile, home } = makeProfile();
  clearScanCache();
  clearSizeCache();

  const first = await scanProfile({ profileDir: profile, dshHome: home });
  const bytesBefore = first.plugins[0].bytes;

  // 往插件里加一个大文件
  const big = Buffer.alloc(512 * 1024, 0x41);
  fs.writeFileSync(path.join(profile, 'local-plugins', 'dsh-demo', 'big.bin'), big);

  const fresh = await scanProfile({ profileDir: profile, dshHome: home, fresh: true });
  assert.ok(fresh.plugins[0].bytes > bytesBefore, 'fresh 必须重算体积');
});

test('源码：本地插件导入与整包导入都会清扫描缓存', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const pluginSrc = fs.readFileSync(path.join(root, 'lib', 'import-plugin.js'), 'utf8');
  assert.ok(pluginSrc.includes('clearScanCache'), 'importLocalPlugin 应清缓存');
  assert.ok(/clearScanCache\(\);\s*\n\s*return \{/.test(pluginSrc), '应在返回结果前清缓存');

  const bundleSrc = fs.readFileSync(path.join(root, 'lib', 'import.js'), 'utf8');
  assert.ok(bundleSrc.includes('clearScanCache'), 'importBundle 应清缓存');

  const scanSrc = fs.readFileSync(path.join(root, 'lib', 'scan.js'), 'utf8');
  assert.ok(scanSrc.includes('localMtime'), '缓存校验应包含 local-plugins 目录 mtime');
  assert.ok(scanSrc.includes('modulesMtime'), '缓存校验应包含 node_modules 目录 mtime');
});

test('源码：启动时后台预热扫描缓存', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'index.js'), 'utf8');
  assert.ok(/scanProfile\(\{\}\)\.catch/.test(src), '启动应后台跑一次扫描暖缓存');
  assert.ok(src.includes('warm scan cache'), '应有说明注释');
});
