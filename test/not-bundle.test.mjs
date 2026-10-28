/**
 * 「zip 不是整合包」的识别与提示。
 *
 * 用户拖进来的可能根本不是整合包：普通压缩包、别的工具打的包、
 * 改名的 rar、半下载的残包。每种都要明确说"这不是整合包"，
 * 而不是抛一个看不懂的底层错误。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { inspectBundle, importBundle } from '../lib/import.js';
import { writeZip } from '../lib/zip.js';
import { writeTgzStream } from '../lib/tar.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-notbundle-suite');

function ensureOut() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  return OUT;
}

/** 抓 inspectBundle 抛的错。 */
function catchInspect(file) {
  try {
    inspectBundle(file);
    return null;
  } catch (error) {
    return error;
  }
}

test('普通 zip（没有 manifest.json）→ "zip 不是整合包"', () => {
  ensureOut();
  const file = path.join(OUT, 'plain.zip');
  // 普通压缩包：只有一些无关文件
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'readme.txt', data: 'hello' },
      { name: 'src/index.js', data: 'console.log(1);' },
    ]),
  );

  const error = catchInspect(file);
  assert.ok(error, '应抛错');
  assert.equal(error.code, 'NOT_A_BUNDLE');
  assert.match(error.message, /zip 不是整合包/, `文案应明确，实际: ${error.message}`);
  assert.match(error.message, /manifest\.json/, '应说明缺什么');
});

test('根本不是 zip 的文件（改名的 rar / 半下载）→ "zip 不是整合包"', () => {
  ensureOut();
  const file = path.join(OUT, 'fake.zip');
  // 前几个字节是 RAR 的魔数，不是 zip
  fs.writeFileSync(file, Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00, 0x0d, 0x00]));

  const error = catchInspect(file);
  assert.ok(error, '应抛错');
  assert.equal(error.code, 'NOT_A_ZIP');
  assert.match(error.message, /zip 不是整合包/, `文案应明确，实际: ${error.message}`);
  assert.match(error.message, /不是有效的 zip/, '应说明它不是 zip');
});

test('空文件 → "zip 不是整合包"', () => {
  ensureOut();
  const file = path.join(OUT, 'empty.zip');
  fs.writeFileSync(file, Buffer.alloc(0));

  const error = catchInspect(file);
  assert.ok(error);
  assert.equal(error.code, 'NOT_A_ZIP');
  assert.match(error.message, /zip 不是整合包/);
});

test('有 manifest.json 但 format 不对 → 说清是什么格式', () => {
  ensureOut();
  const file = path.join(OUT, 'wrongformat.zip');
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'manifest.json', data: JSON.stringify({ format: 'some-other-tool@1', plugins: [] }, null, 2) },
      { name: 'a.txt', data: 'x' },
    ]),
  );

  const error = catchInspect(file);
  assert.ok(error);
  assert.equal(error.code, 'BAD_FORMAT');
  assert.match(error.message, /zip 不是整合包/);
  assert.match(error.message, /some-other-tool@1/, '应报出实际格式，方便用户判断');
});

test('manifest.json 是坏 JSON → 说清楚解析失败', () => {
  ensureOut();
  const file = path.join(OUT, 'badjson.zip');
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'manifest.json', data: '{ 这不是合法 json' },
      { name: 'a.txt', data: 'x' },
    ]),
  );

  const error = catchInspect(file);
  assert.ok(error);
  assert.equal(error.code, 'BAD_MANIFEST');
  assert.match(error.message, /zip 不是整合包/);
  assert.match(error.message, /无法解析/, '应说明是 JSON 坏了');
});

test('文件不存在 → 404 类的提示（区别于"不是整合包"）', () => {
  ensureOut();
  const error = catchInspect(path.join(OUT, 'missing.zip'));
  assert.ok(error);
  assert.equal(error.code, 'NOT_FOUND');
  assert.match(error.message, /不存在/);
});

test('真正的整合包不受影响，仍能正常识别', async () => {
  ensureOut();
  const { exportBundle } = await import('../lib/export.js');
  const pack = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });

  const info = inspectBundle(pack.file);
  assert.ok(info, '正常包不应抛错');
  assert.equal(info.plugins.length, 2);
  assert.ok(info.manifest.format.startsWith('dsh-plugin-pack@'));
});

test('tgz 走的是另一条路，不受「不是整合包」影响', async () => {
  ensureOut();
  // 手造一个合法 tgz（有 package.json，是单个插件包）
  const file = path.join(OUT, 'single.tgz');
  await writeTgzStream(
    [
      { name: 'package/package.json', data: JSON.stringify({ name: 'solo', version: '1.0.0' }) },
      { name: 'package/index.js', data: 'export default 1;' },
    ],
    file,
  );
  const { isTarball, importTarball } = await import('../lib/import-tgz.js');
  assert.equal(isTarball(file), true);

  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');

  const result = importTarball({ file, home: OUT, profileDir: profile });
  assert.equal(result.ok, true, '合法的单插件 tgz 应能导入');
  assert.equal(result.name, 'solo');
});

test('importBundle 对非整合包同样给出明确错误', () => {
  ensureOut();
  const file = path.join(OUT, 'plain2.zip');
  fs.writeFileSync(file, writeZip([{ name: 'x.txt', data: 'y' }]));

  const profile = path.join(OUT, 'profile2');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), '{}');

  let caught = null;
  try {
    importBundle({ file, profileDir: profile });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.equal(caught.code, 'NOT_A_BUNDLE');
  assert.match(caught.message, /zip 不是整合包/);
});
