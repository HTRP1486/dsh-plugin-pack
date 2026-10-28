/**
 * 浏览器端快速读 zip（peekZip）的等价实现验证。
 *
 * 解决的问题：拖入几百 MB 的整合包时，原流程要「整个文件上传 → 服务端 dryRun
 * → 才弹冲突窗」，用户等半分钟才看到"哪些要覆盖"。
 *
 * 现在改成先在浏览器里只读 zip 尾巴（EOCD + 中央目录 + manifest.json），
 * 几百毫秒就能列出冲突，点确认之后才真正上传。
 *
 * 这里用 Node 复刻那套解析逻辑，对真实的 zip 验证：
 *   1. 只读尾部就能拿到全部条目名
 *   2. 能解出 manifest.json
 *   3. 大文件也不需要读全量（读的字节数远小于文件大小）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';

import { writeZip } from '../lib/zip.js';
import { exportBundle } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-peek-suite');

/**
 * 复刻 client.js 里的 peekZip：只读尾部，解析 EOCD → 中央目录 → 指定条目。
 *
 * @param {Buffer} full 完整文件（模拟 File，实际只会切片读）
 * @param {(from: number, to: number) => Buffer} read 切片读取函数
 */
function peekZipWith(full, read) {
  const size = full.length;
  if (size < 22) return null;

  const tailLen = Math.min(size, 2 * 1024 * 1024);
  const tail = read(size - tailLen, size);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = tail[eocd + 10] | (tail[eocd + 11] << 8);
  const cdSize = tail[eocd + 12] | (tail[eocd + 13] << 8) | (tail[eocd + 14] << 16) | (tail[eocd + 15] << 24);
  const cdOffset = tail[eocd + 16] | (tail[eocd + 17] << 8) | (tail[eocd + 18] << 16) | (tail[eocd + 19] << 24);

  const separate = cdOffset < size - tailLen;
  const cd = separate ? read(cdOffset, cdOffset + cdSize) : tail;
  const base = separate ? 0 : cdOffset - (size - tailLen);

  const names = [];
  let p = base;
  while (p + 46 <= cd.length && names.length < total) {
    if (!(cd[p] === 0x50 && cd[p + 1] === 0x4b && cd[p + 2] === 0x01 && cd[p + 3] === 0x02)) break;
    const nameLen = cd[p + 28] | (cd[p + 29] << 8);
    const extraLen = cd[p + 30] | (cd[p + 31] << 8);
    const commentLen = cd[p + 32] | (cd[p + 33] << 8);
    names.push(cd.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.length) return null;

  // 解 manifest.json
  let manifest = null;
  p = base;
  while (p + 46 <= cd.length) {
    if (!(cd[p] === 0x50 && cd[p + 1] === 0x4b && cd[p + 2] === 0x01 && cd[p + 3] === 0x02)) break;
    const method = cd[p + 10] | (cd[p + 11] << 8);
    const compSize = cd[p + 20] | (cd[p + 21] << 8) | (cd[p + 22] << 16) | (cd[p + 23] << 24);
    const nameLen = cd[p + 28] | (cd[p + 29] << 8);
    const extraLen = cd[p + 30] | (cd[p + 31] << 8);
    const commentLen = cd[p + 32] | (cd[p + 33] << 8);
    const localOffset = cd[p + 42] | (cd[p + 43] << 8) | (cd[p + 44] << 16) | (cd[p + 45] << 24);
    const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8').replace(/\\/g, '/');

    if (name === 'manifest.json') {
      const local = read(localOffset, localOffset + 30);
      const lNameLen = local[26] | (local[27] << 8);
      const lExtraLen = local[28] | (local[29] << 8);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = read(dataStart, dataStart + compSize);
      const bytes = method === 8 ? zlib.inflateRawSync(raw) : raw;
      manifest = JSON.parse(bytes.toString('utf8'));
      break;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  return { names, manifest };
}

test('只读尾部就能列出全部条目名（读的字节远小于文件）', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'a.zip');
  // 用 store（不压缩）造真实体积：模拟未压缩的 tgz 条目
  const big = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'manifest.json', data: JSON.stringify({ format: 'dsh-plugin-pack@2', plugins: [{ name: 'x' }] }) },
      { name: 'packages/aaa-1.0.0.tgz', data: big, store: true },
      { name: 'packages/bbb-2.0.0.tgz', data: big, store: true },
    ]),
  );

  const full = fs.readFileSync(file);
  assert.ok(full.length > 7 * 1024 * 1024, `文件应是真的 8 MiB 级，实际 ${full.length}`);

  let bytesRead = 0;
  const read = (from, to) => {
    bytesRead += to - from;
    return full.subarray(from, to);
  };

  const peek = peekZipWith(full, read);
  assert.ok(peek, '应能解析');
  assert.ok(peek.names.includes('manifest.json'));
  assert.ok(peek.names.some((n) => n.endsWith('.tgz')));
  // 8 MiB 的包，只读 2 MiB 尾部窗口 + 中央目录
  assert.ok(
    bytesRead < full.length / 2,
    `只该读一部分，实际读了 ${bytesRead} / ${full.length}（${(full.length / 1048576).toFixed(1)} MiB）`,
  );
});

test('能解出 manifest.json 的 plugins 列表', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'b.zip');
  const manifest = {
    format: 'dsh-plugin-pack@2',
    layout: 'tarballs',
    plugins: [
      { name: 'dsh-pet', version: '0.3.8', tgz: 'packages/dsh-pet-0.3.8.tgz' },
      { name: 'dsh-ops', version: '0.4.1', tgz: 'packages/dsh-ops-0.4.1.tgz' },
    ],
  };
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: 'packages/dsh-pet-0.3.8.tgz', data: Buffer.alloc(1000) },
      { name: 'packages/dsh-ops-0.4.1.tgz', data: Buffer.alloc(1000) },
    ]),
  );

  const full = fs.readFileSync(file);
  const peek = peekZipWith(full, (from, to) => full.subarray(from, to));
  assert.ok(peek);
  assert.equal(peek.manifest.format, 'dsh-plugin-pack@2');
  assert.equal(peek.manifest.plugins.length, 2);
  assert.equal(peek.manifest.plugins[0].name, 'dsh-pet');
});

test('真实导出的整合包能被 peek 解析', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const pack = await exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });

  const full = fs.readFileSync(pack.file);
  const peek = peekZipWith(full, (from, to) => full.subarray(from, to));
  assert.ok(peek, '真实包应能被 peek 解析');
  assert.ok(peek.manifest, '应解出 manifest');
  assert.equal(peek.manifest.plugins.length, 2);
  const names = peek.manifest.plugins.map((p) => p.name);
  assert.ok(names.includes('dsh-plugin-pack'));
  assert.ok(names.includes('dsh-one-click-polish'));
});

test('普通 zip（没有 manifest）→ manifest 为 null，界面据此报"不是整合包"', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'plain.zip');
  fs.writeFileSync(file, writeZip([{ name: 'readme.txt', data: 'hi' }, { name: 'a/b.txt', data: 'x' }]));

  const full = fs.readFileSync(file);
  const peek = peekZipWith(full, (from, to) => full.subarray(from, to));
  assert.ok(peek, '仍是有效 zip');
  assert.equal(peek.manifest, null, '没有 manifest 应返回 null');
  assert.equal(peek.names.length, 2);
});

test('不是 zip 的文件 → 返回 null', () => {
  const full = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x0d, 0x00, 0x01, 0x02, 0x03]);
  const peek = peekZipWith(full, (from, to) => full.subarray(from, to));
  assert.equal(peek, null);
});
