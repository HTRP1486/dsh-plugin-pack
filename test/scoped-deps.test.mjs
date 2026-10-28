/**
 * scoped 依赖的路径结构回归测试。
 *
 * 真实事故：dsh-pet 导出后重新导入，启动报
 *   ERR_MODULE_NOT_FOUND: Cannot find package '@electron/get'
 *
 * 根因：打包时把 `@electron/get` 压成了单层目录 `@electron__get`。
 * packSegment 是用来做「local-plugins 下的单层插件目录名」的，
 * 用在 node_modules 里会破坏 Node 的模块解析（它要求 @scope/name 两级）。
 *
 * 这个测试盯死：node_modules 里的 scoped 包必须保持 @scope/name 结构。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { exportBundle } from '../lib/export.js';
import { importBundle } from '../lib/import.js';
import { importTarball } from '../lib/import-tgz.js';
import { readTgz } from '../lib/tar.js';
import { packSegment } from '../lib/home.js';
import { createRequire } from 'node:module';

const OUT = path.join(os.tmpdir(), 'dsh-pp-scoped-suite');

/** 检查 tgz 里的 node_modules 结构。 */
function nodeModulesDirs(items) {
  const prefix = 'package/node_modules/';
  const dirs = new Set();
  for (const item of items) {
    if (!item.name.startsWith(prefix)) continue;
    const rest = item.name.slice(prefix.length);
    const segments = rest.split('/');
    if (segments[0].startsWith('@')) {
      // scoped：@scope/name/...
      if (segments.length >= 3) dirs.add(`${segments[0]}/${segments[1]}`);
    } else if (segments.length >= 2) {
      dirs.add(segments[0]);
    }
  }
  return dirs;
}

test('packSegment 压扁 scoped 名（这是它该做的，只用于单层目录）', async () => {
  // 确认这个函数的行为：@electron/get → @electron__get
  // 它本身没错，错的是把它用在了 node_modules 里
  assert.equal(packSegment('@electron/get'), '@electron__get');
  assert.equal(packSegment('dsh-plugin-pack'), 'dsh-plugin-pack');
});

test('导出的 tgz 里 scoped 依赖保持 @scope/name 两级结构', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-pet'], out: `${OUT}\\`, maxBytes: 0 });
  const items = readTgz(fs.readFileSync(result.file));

  const dirs = nodeModulesDirs(items);

  // 关键断言 1：不该有任何 __ 压扁命名
  const flattened = [...dirs].filter((d) => d.includes('__'));
  assert.deepEqual(flattened, [], `node_modules 里不该出现压扁命名，实际: ${flattened.join(',')}`);

  // 关键断言 2：@electron/get 必须在正确路径下
  const hasElectronGet = items.some((item) => item.name.startsWith('package/node_modules/@electron/get/'));
  assert.equal(hasElectronGet, true, '必须存在 package/node_modules/@electron/get/ 目录');

  // 它的 package.json 也要在
  const pkgEntry = items.find((item) => item.name === 'package/node_modules/@electron/get/package.json');
  assert.ok(pkgEntry, '应有 @electron/get/package.json');
  const meta = JSON.parse(pkgEntry.data.toString('utf8'));
  assert.equal(meta.name, '@electron/get', '包名应保持 @scope/name');

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('所有 scoped 依赖都必须是 @scope/name 形式（抽查多个）', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-pet'], out: `${OUT}\\`, maxBytes: 0 });
  const items = readTgz(fs.readFileSync(result.file));
  const dirs = nodeModulesDirs(items);

  const scoped = [...dirs].filter((d) => d.startsWith('@'));
  assert.ok(scoped.length > 0, 'dsh-pet 应有 scoped 依赖');

  for (const dir of scoped) {
    assert.ok(dir.includes('/'), `scoped 依赖必须是 @scope/name，实际 ${dir}`);
    assert.equal(dir.includes('__'), false, `不该有压扁命名: ${dir}`);
    assert.equal(dir.split('/').length, 2, `scoped 依赖层级应是 2，实际 ${dir}`);
  }

  // 已知的几条必须都在
  for (const expected of ['@electron/get', '@anthropic-ai/sdk', '@electron-internal/extract-zip']) {
    assert.ok(dirs.has(expected), `应包含 ${expected}，实际有: ${[...dirs].filter((d) => d.startsWith('@')).join(', ')}`);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('导入后 node_modules 的 scoped 依赖能被 Node 解析', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  // 单个插件导出的是 .tgz，所以导入也要走 Tarball 那条路
  const result = await exportBundle({ include: ['dsh-pet'], out: `${OUT}\\`, maxBytes: 0 });
  assert.ok(result.file.endsWith('.tgz'), `单个插件应导出 .tgz，实际 ${result.file}`);

  // 解到假 profile
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');

  const imported = importTarball({ file: result.file, home: OUT, profileDir: profile });
  assert.equal(imported.ok, true);

  const dest = path.join(profile, 'local-plugins', 'dsh-pet');
  // 物理目录检查：@electron/get 应该是两级
  assert.equal(fs.existsSync(path.join(dest, 'node_modules', '@electron', 'get', 'package.json')), true, '应解成 @electron/get 两级目录');
  // 不该有压扁版本
  assert.equal(fs.existsSync(path.join(dest, 'node_modules', '@electron__get')), false, '不该有 @electron__get');

  // 用 Node 自己的解析器验证（最有力的证据）
  const req = createRequire(path.join(dest, 'lib', 'index.js'));
  const resolved = req.resolve('@electron/get');
  assert.ok(resolved.includes(`@electron${path.sep}get`), `Node 应能解析 @electron/get，实际 ${resolved}`);

  fs.rmSync(OUT, { recursive: true, force: true });
});
