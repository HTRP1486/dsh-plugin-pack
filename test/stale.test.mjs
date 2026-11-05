/**
 * 「残留」插件不该被当成"已装"。
 *
 * 现象：用户点卸载后，dsh 删了 package.json 里的条目，但 pnpm 报错没跑完，
 * 于是 local-plugins 目录和 node_modules 链接留在磁盘上。
 * 下次导入时这些插件会被识别为"已装 2.0.0"，用户就会问：
 * "我明明删了，怎么还显示？"
 *
 * 修法：只有**声明过**（在 dependencies 或 bundles 里）才算已装。
 * 磁盘上留着文件但没声明的，当"新建"处理 —— 导入时会先备份原目录再覆盖，
 * 不会丢东西。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { importBundle } from '../lib/import.js';
import { exportBundle } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-leftover');

/** 造 profile：declared 正常声明，leftover 只有文件没有声明。 */
function makeProfile(name, { declared = [], leftover = [] } = {}) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'local-plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

  const dependencies = {};
  const bundles = [];

  for (const pluginName of declared) {
    const pluginDir = path.join(dir, 'local-plugins', pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: pluginName, version: '1.0.0' }));
    dependencies[pluginName] = `link:./local-plugins/${pluginName}`;
    bundles.push(pluginName);
  }

  for (const pluginName of leftover) {
    const pluginDir = path.join(dir, 'local-plugins', pluginName);
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: pluginName, version: '9.9.9' }));
    fs.writeFileSync(path.join(pluginDir, 'index.js'), 'export default 1;');
  }

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# x\n');
  return dir;
}

/** 导一个含两个插件的整合包。 */
async function makeBundle() {
  return exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${TMP}\\`, maxBytes: 0 });
}

test('残留插件不算"已装"，按新建处理', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('leftover-only', {
    declared: ['dsh-plugin-pack'],
    leftover: ['dsh-one-click-polish'],
  });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });

  const declared = preview.plugins.find((plugin) => plugin.name === 'dsh-plugin-pack');
  const leftover = preview.plugins.find((plugin) => plugin.name === 'dsh-one-click-polish');

  assert.equal(declared.exists, true, '声明过的应算已装');
  assert.equal(leftover.exists, false, '只有文件没声明的，不算已装');
  assert.equal(leftover.stale, true, '内部仍标记为残留，便于排查');
  assert.equal(leftover.action, 'create', '应走新建');
});

test('残留不会进 conflicts（弹窗里不会显示成"已装"）', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('no-conflict', {
    declared: [],
    leftover: ['dsh-plugin-pack', 'dsh-one-click-polish'],
  });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });
  assert.deepEqual(preview.conflicts, [], '两个都只是残留，不该算冲突');
});

test('真覆盖时仍会备份残留目录，不丢数据', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('backup', { declared: [], leftover: ['dsh-one-click-polish'] });
  const leftoverDir = path.join(profile, 'local-plugins', 'dsh-one-click-polish');
  const marker = path.join(leftoverDir, 'MY-LOCAL-EDIT.txt');
  fs.writeFileSync(marker, '别删我');

  const result = importBundle({ file: bundle.file, profileDir: profile });
  assert.equal(result.ok, true);

  // 备份里应能找到被替换的目录（含那个标记文件）
  const record = JSON.parse(fs.readFileSync(path.join(result.backup, 'record.json'), 'utf8'));
  const replaced = (record.replacedDirs ?? []).find((item) => item.dest === leftoverDir);
  assert.ok(replaced, '残留目录被覆盖前应记进 replacedDirs');
  assert.equal(fs.existsSync(path.join(replaced.backup, 'MY-LOCAL-EDIT.txt')), true, '备份里应保留原文件');
});

test('界面源码：版本未知时显示「安装时取最新版」，不显示 null', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  assert.ok(src.includes('conflict.latestOnInstall'), '应有「安装时取最新版」文案');
  assert.ok(
    /item\.version\s*\r?\n?\s*\?/.test(src) || src.includes('item.version ?? t(\'conflict.latestOnInstall\')'),
    '版本为 null 时应回退到提示文案',
  );
  // 不该再有清理残留的界面
  assert.equal(src.includes('stale.title'), false, '不该有残留清理卡片');
  assert.equal(src.includes('runCleanStale'), false, '不该有清理按钮');
});

test('服务端源码：不再提供 clean-stale 接口', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverSrc = fs.readFileSync(path.join(root, 'lib', 'server.js'), 'utf8');
  const repairSrc = fs.readFileSync(path.join(root, 'lib', 'repair.js'), 'utf8');

  assert.equal(serverSrc.includes('clean-stale'), false, '不该有清理残留接口');
  assert.equal(repairSrc.includes('cleanStale'), false, '不该有清理残留实现');
});
