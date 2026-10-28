/**
 * 导出的两种形态：勾 1 个 = 单个插件，勾多个 = 整合包。
 *
 * 以前是用户手动选页签，现在由勾选数量决定。后端本来就是同一个导出函数
 * （include 列表里放 1 个还是多个），这里验证两种情形都产出合法包，
 * 并且单个插件包确实只含那一个插件。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { exportBundle } from '../lib/export.js';
import { readZipMeta, extractEntry } from '../lib/zip.js';
import { readTgz } from '../lib/tar.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-scope-test');

/** 读 zip 里的 manifest。 */
function manifestOf(file) {
  const buffer = fs.readFileSync(file);
  const records = readZipMeta(buffer);
  const record = records.find((r) => r.name === 'manifest.json');
  assert.ok(record, '包内应有 manifest.json');
  return JSON.parse(extractEntry(buffer, record).toString('utf8'));
}

test('勾 1 个插件 → 包是 .tgz，且只含这一个插件', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({
    include: ['dsh-plugin-pack'],
    out: `${OUT}\\`,
    maxBytes: 0,
  });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'plugin', '单插件应走 tarball');
  assert.ok(result.file.endsWith('.tgz'), `单个插件应是 .tgz，实际 ${result.file}`);
  assert.equal(result.plugins.length, 1, '应只导出 1 个插件');
  assert.equal(result.plugins[0].name, 'dsh-plugin-pack');

  // 解包看内容：package/ 下只有一个包的 package.json，没有别的包
  const items = readTgz(fs.readFileSync(result.file));
  const pkgJsons = items.filter((item) => item.name === 'package/package.json');
  assert.equal(pkgJsons.length, 1, '只该有一个 package/package.json');
  const meta = JSON.parse(pkgJsons[0].data.toString('utf8'));
  assert.equal(meta.name, 'dsh-plugin-pack');

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('勾多个插件 → 整合包含全部被勾选的', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const picked = ['dsh-plugin-pack', 'dsh-one-click-polish'];
  const result = await exportBundle({ include: picked, out: `${OUT}\\`, maxBytes: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.plugins.length, 2);
  const names = result.plugins.map((p) => p.name).sort();
  assert.deepEqual(names, [...picked].sort());

  const manifest = manifestOf(result.file);
  assert.equal(manifest.plugins.length, 2);

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('两种形态格式不同：单个是 tgz(npm 包)，多个是 zip(整合包)', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });

  const single = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\single\\`, maxBytes: 0 });
  const multi = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\multi\\`, maxBytes: 0 });

  // 单个插件：npm tarball
  assert.equal(single.kind, 'plugin');
  assert.ok(single.file.endsWith('.tgz'));
  const tgzItems = readTgz(fs.readFileSync(single.file));
  assert.ok(tgzItems.some((item) => item.name === 'package/package.json'), 'tgz 应是标准 npm 包结构');
  assert.equal(tgzItems.some((item) => item.name === 'package/manifest.json'), false, 'tgz 不该带整合包的 manifest');

  // 多个插件：整合包 zip（内部每个插件一个 tgz）
  assert.equal(multi.kind, 'bundle');
  assert.ok(multi.file.endsWith('.zip'));
  const b = manifestOf(multi.file);
  assert.equal(b.format, 'dsh-plugin-pack@2', 'zip 应带 v2 整合包标识');
  assert.equal(b.layout, 'tarballs', 'v2 布局是每个插件一个 tgz');
  assert.equal(b.plugins.length, 2);
  // manifest 里每个插件都应指向自己的 tgz
  for (const plugin of b.plugins) {
    assert.ok(plugin.tgz && plugin.tgz.endsWith('.tgz'), `${plugin.name} 应有 tgz 路径，实际 ${plugin.tgz}`);
  }

  // 两者的容器格式确实不同（一个是 zip 中央目录，一个是 gzip）
  const tgzHead = fs.readFileSync(single.file).subarray(0, 2);
  assert.equal(tgzHead[0], 0x1f, 'tgz 应以 gzip 魔数 1f 开头');
  assert.equal(tgzHead[1], 0x8b);
  const zipHead = fs.readFileSync(multi.file).subarray(0, 2);
  assert.equal(zipHead[0], 0x50, 'zip 应以 PK 开头');
  assert.equal(zipHead[1], 0x4b);

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('一个都没勾时抛错，不产出空包', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  await assert.rejects(async () => exportBundle({ include: [], out: `${OUT}\\`, maxBytes: 0 }), /没有可导出的插件|NO_PLUGINS/);
});
