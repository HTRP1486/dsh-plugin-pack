/**
 * 单个插件 = .tgz（npm tarball），多个插件 = .zip（整合包）。
 *
 * 断言四件事：
 *   1. 勾 1 个 → 产出 .tgz，且是合法 npm tarball（package/ 前缀）
 *   2. tar 结构正确（能被本插件自己的 readTgz 读出来，且与 npm 的读法一致）
 *   3. .tgz 能作为本地插件导入回 profile
 *   4. 勾多个 → 仍是 .zip
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { exportBundle, resolveOutFile } from '../lib/export.js';
import { writeTgzStream, readTgz, tarHeader } from '../lib/tar.js';
import { isTarball, unpackTarball, importTarball } from '../lib/import-tgz.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-tgz-suite');

/* ------------------------------ tar 基础格式 ------------------------------ */

test('tarHeader 产出合法的 ustar 头', async () => {
  const header = tarHeader({ name: 'package/index.js', size: 42, mtime: 1700000000000 });
  assert.equal(header.length, 512);
  assert.equal(header.toString('utf8', 257, 263), 'ustar\0', '应有 ustar 魔数');
  // 名字字段以 NUL 补齐到 100 字节（这是 tar 规范，不是 bug）
  assert.equal(header.toString('utf8', 0, 100).replace(/\0+$/, ''), 'package/index.js');
  // size 是八进制
  assert.equal(parseInt(header.toString('utf8', 124, 136).replace(/\0.*$/, ''), 8), 42);
  // type 普通文件
  assert.equal(header.toString('utf8', 156, 157), '0');
  // 校验和字段应非空
  assert.ok(header.toString('utf8', 148, 156).trim());
});

test('tarHeader 校验和正确（按规范重算）', async () => {
  const header = tarHeader({ name: 'a.txt', size: 5, mtime: 1700000000000 });
  const recorded = parseInt(header.toString('utf8', 148, 154), 8);
  // 计算时把校验和字段当作 8 个空格
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of copy) sum += byte;
  assert.equal(sum, recorded, '校验和必须与规范一致');
});

test('writeTgzStream + readTgz 往返一致', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const file = path.join(OUT, 'roundtrip.tgz');
  const result = await writeTgzStream(
    [
      { name: 'package/package.json', data: '{"name":"x"}' },
      { name: 'package/lib/a.js', data: 'export const a = 1;' },
      { name: 'package/empty.txt', data: '' },
    ],
    file,
  );
  assert.equal(result.entries, 3);

  const items = readTgz(fs.readFileSync(file));
  assert.equal(items.length, 3);
  assert.equal(items[0].name, 'package/package.json');
  assert.equal(items[0].data.toString(), '{"name":"x"}');
  assert.equal(items[1].name, 'package/lib/a.js');
  assert.equal(items[2].data.length, 0, '空文件应能还原');
});

test('长路径走 prefix 字段而不是报错', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const longDir = 'package/' + 'a'.repeat(120);
  const name = `${longDir}/file.js`;
  const file = path.join(OUT, 'long.tgz');
  // 异步函数要用 await 而不是 assert.doesNotThrow（后者抓不到 Promise 里的异常）
  await writeTgzStream([{ name, data: 'x' }], file);
  const items = readTgz(fs.readFileSync(file));
  assert.equal(items[0].name, name, '长路径应能完整还原');
});

/* ----------------------------- 导出：单 vs 多 ----------------------------- */

test('勾 1 个插件 → 产出 .tgz', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\`, maxBytes: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'plugin', 'kind 应为 plugin');
  assert.ok(result.file.endsWith('.tgz'), `应为 .tgz，实际 ${result.file}`);
  assert.equal(fs.existsSync(result.file), true);
  assert.ok(result.bytes > 0);
});

test('.tgz 内容是标准 npm 包：package/ 前缀 + package.json', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\`, maxBytes: 0 });
  const items = readTgz(fs.readFileSync(result.file));

  assert.ok(items.length > 5, `条目应不止几个，实际 ${items.length}`);
  // 所有条目都要在 package/ 下
  const outside = items.filter((item) => !item.name.startsWith('package/'));
  assert.deepEqual(outside, [], `所有条目都应在 package/ 下，越界: ${outside.map((i) => i.name).join(',')}`);

  const pkgJson = items.find((item) => item.name === 'package/package.json');
  assert.ok(pkgJson, '必须有 package/package.json');
  const meta = JSON.parse(pkgJson.data.toString('utf8'));
  assert.equal(meta.name, 'dsh-plugin-pack');
  assert.ok(meta.exports['./client'], 'package.json 里应有 ./client 导出');
  assert.equal(meta.dsh.client.platform, 'web');

  // 客户端入口真的在包里
  assert.ok(items.some((item) => item.name === 'package/client.js'), '应含 client.js');
  assert.ok(items.some((item) => item.name === 'package/lib/index.js'), '应含服务端入口');
});

test('勾多个插件 → 仍是 .zip 整合包', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });

  assert.equal(result.ok, true);
  assert.equal(result.kind, 'bundle', 'kind 应为 bundle');
  assert.ok(result.file.endsWith('.zip'), `应为 .zip，实际 ${result.file}`);
});

test('resolveOutFile 按类型给正确扩展名', async () => {
  // 目录 + 单插件 → .tgz，文件名用包名
  const dirCase = resolveOutFile('D:\\Temp\\x\\', 'C:/home', 'desktop', '20260101-000000', {
    kind: 'plugin',
    pluginName: 'dsh-pet',
  });
  assert.ok(dirCase.endsWith('.tgz'));
  assert.ok(path.basename(dirCase).startsWith('dsh-pet-'), `文件名应含包名，实际 ${path.basename(dirCase)}`);

  // 目录 + 整合包 → .zip
  const bundleCase = resolveOutFile('D:\\Temp\\x\\', 'C:/home', 'desktop', '20260101-000000', { kind: 'bundle' });
  assert.ok(bundleCase.endsWith('.zip'));

  // scoped 包名里的 / 要被替换掉
  const scoped = resolveOutFile('D:\\Temp\\x\\', 'C:/home', 'p', 'ts', { kind: 'plugin', pluginName: '@local/x' });
  assert.equal(path.basename(scoped).includes('/'), false);
  assert.ok(scoped.endsWith('.tgz'));
});

/* ------------------------------- 导入 .tgz ------------------------------- */

test('isTarball 识别扩展名', async () => {
  assert.equal(isTarball('a.tgz'), true);
  assert.equal(isTarball('A.TGZ'), true);
  assert.equal(isTarball('a.tar.gz'), true);
  assert.equal(isTarball('a.zip'), false);
  assert.equal(isTarball('a.js'), false);
});

test('unpackTarball 去掉 package/ 前缀', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const file = path.join(OUT, 'unpack.tgz');
  await writeTgzStream(
    [
      { name: 'package/package.json', data: '{"name":"demo","version":"1.0.0"}' },
      { name: 'package/lib/index.js', data: 'export const x=1;' },
    ],
    file,
  );

  const unpacked = unpackTarball({ file, home: OUT });
  assert.equal(unpacked.hasPackagePrefix, true);
  assert.equal(unpacked.files, 2);
  assert.equal(fs.existsSync(path.join(unpacked.dir, 'package.json')), true, '应去掉 package/ 前缀');
  assert.equal(fs.existsSync(path.join(unpacked.dir, 'lib', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(unpacked.dir, 'package')), false, '不该留下 package/ 这一层');
});

test('unpackTarball 挡住路径穿越', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const file = path.join(OUT, 'evil.tgz');
  await writeTgzStream(
    [
      { name: 'package/../../escape.txt', data: 'bad' },
      { name: 'package/ok.txt', data: 'good' },
    ],
    file,
  );
  const unpacked = unpackTarball({ file, home: OUT });
  assert.equal(fs.existsSync(path.join(unpacked.dir, 'ok.txt')), true);
  const escaped = path.resolve(unpacked.dir, '../../../escape.txt');
  assert.equal(fs.existsSync(escaped), false, '不该写出解包目录');
});

test('导出的 .tgz 能导入回 profile', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });

  // 1) 导出
  const exported = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\export\\`, maxBytes: 0 });
  assert.ok(exported.file.endsWith('.tgz'));

  // 2) 造一个空 profile
  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');

  // 3) 导入
  const result = importTarball({ file: exported.file, home: OUT, profileDir: profile });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fromTarball, true);
  assert.equal(result.name, 'dsh-plugin-pack');

  // 4) 落地检查
  const dest = path.join(profile, 'local-plugins', 'dsh-plugin-pack');
  assert.equal(fs.existsSync(path.join(dest, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(dest, 'client.js')), true);

  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['dsh-plugin-pack'], 'link:./local-plugins/dsh-plugin-pack');
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-plugin-pack'));
});

test('没有 package.json 的 tgz 被拒绝', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const file = path.join(OUT, 'bad.tgz');
  await writeTgzStream([{ name: 'package/readme.txt', data: 'x' }], file);
  assert.throws(() => importTarball({ file, home: OUT, profileDir: OUT }), /package\.json/);
});
