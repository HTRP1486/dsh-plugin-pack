/**
 * 盘符根作导出目标的回归测试。
 *
 * 用户把「保存到」填成 D:\ 时，导出报 `EPERM: operation not permitted, mkdir 'D:\'`。
 * 原因：对已存在的盘符根调用 mkdirSync 会抛 EPERM（Windows 不允许"创建"root）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { ensureDir } from '../lib/util.js';
import { writeZipStream } from '../lib/zip-stream.js';
import { exportBundle } from '../lib/export.js';
import { resolveOutFile } from '../lib/export.js';

const WORK = path.join(os.tmpdir(), 'dsh-pp-rootdir-test');

test('ensureDir 对已存在的盘符根不报错', async () => {
  for (const root of ['C:\\', 'D:\\']) {
    if (!fs.existsSync(root)) continue;
    assert.doesNotThrow(() => ensureDir(root), `${root} 应能安全通过`);
  }
});

test('ensureDir 对普通目录仍然正常创建', async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  const deep = path.join(WORK, 'a', 'b', 'c');
  ensureDir(deep);
  assert.equal(fs.existsSync(deep), true);
});

test('writeZipStream 能直接写进盘符根下的文件', async () => {
  const root = fs.existsSync('D:\\') ? 'D:\\' : 'C:\\';
  const outFile = path.join(root, `dsh-rootdir-probe-${Date.now()}.zip`);
  try {
    const result = await writeZipStream([{ name: 'a.txt', data: 'hello' }], outFile);
    assert.ok(result.bytes > 0);
    assert.equal(fs.existsSync(outFile), true);
  } finally {
    try {
      fs.unlinkSync(outFile);
    } catch {
      /* 清理失败无妨 */
    }
  }
});

test('resolveOutFile 把 D:\\ 识别为目录而不是文件名', async () => {
  if (!fs.existsSync('D:\\')) return;
  const out = resolveOutFile('D:\\', 'C:/home', 'desktop', '20260101-000000');
  assert.equal(path.dirname(path.resolve(out)), path.resolve('D:\\'));
  assert.ok(out.endsWith('.zip'));
  assert.equal(out.includes('D:\\.zip'), false, '不能变成 D:\\.zip');
});

test('导出到盘符根：完整走通一次', async () => {
  if (!fs.existsSync('D:\\')) return;
  const before = fs.readdirSync('D:\\').filter((n) => n.endsWith('.zip'));
  const result = await exportBundle({ include: ['dsh-plugin-pack'], out: 'D:\\', maxBytes: 0 });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.file), true, '包应真的落在 D:\\ 上');
  assert.equal(path.dirname(path.resolve(result.file)), path.resolve('D:\\'));

  // 清理
  try {
    fs.unlinkSync(result.file);
  } catch {
    /* 忽略 */
  }
  const after = fs.readdirSync('D:\\').filter((n) => n.endsWith('.zip'));
  assert.equal(after.length, before.length, '不应残留');
});
