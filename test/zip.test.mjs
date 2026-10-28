/**
 * lib/zip.js 的单元测试：只依赖 node:test + node:assert/strict + node:zlib。
 *
 * 运行：node --test test/zip.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { writeZip, readZip, crc32, zipStats, safeJoin } from '../lib/zip.js';

/**
 * 生成确定性伪随机字节，失败时可复现。
 *
 * @param {number} length
 * @param {number} seed
 * @returns {Buffer}
 */
function makeBytes(length, seed) {
  const buffer = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[index] = state >>> 24;
  }
  return buffer;
}

/**
 * 手工构造一个带 bit 3（data descriptor）的单条目 zip。
 *
 * local header 里的 CRC / 长度留 0，真实值写在数据后面的 descriptor 里，
 * central directory 里写真实值。
 *
 * @param {string} name
 * @param {Buffer} data
 * @returns {Buffer}
 */
function buildDataDescriptorZip(name, data) {
  const nameBuf = Buffer.from(name, 'utf8');
  const compressed = deflateRawSync(data, { level: 9 });
  const checksum = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0808, 6); // bit 11（UTF-8）+ bit 3（data descriptor）
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0x0021, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(checksum, 4);
  descriptor.writeUInt32LE(compressed.length, 8);
  descriptor.writeUInt32LE(data.length, 12);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0808, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42); // local header 偏移 = 0

  const centralOffset = 30 + nameBuf.length + compressed.length + descriptor.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, nameBuf, compressed, descriptor, central, nameBuf, eocd]);
}

test('crc32 与已知向量一致', () => {
  assert.equal(crc32(Buffer.from('123456789', 'ascii')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('5000 字节随机数据 round-trip 字节完全一致', () => {
  const data = makeBytes(5000, 20261026);
  const entries = readZip(writeZip([{ name: 'random.bin', data }]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'random.bin');
  assert.equal(entries[0].method, 8);
  assert.equal(entries[0].size, 5000);
  assert.equal(entries[0].data.length, 5000);
  assert.deepEqual(entries[0].data, data);
});

test('UTF-8 中文文件名 + 嵌套路径 round-trip', () => {
  const name = 'packages/插件名/lib/index.js';
  const source = 'export const 你好 = "世界";\n';
  const entries = readZip(writeZip([{ name, data: source }]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, name);
  assert.equal(entries[0].data.toString('utf8'), source);
});

test('空文件（0 字节）round-trip', () => {
  const entries = readZip(writeZip([{ name: 'empty.txt', data: Buffer.alloc(0) }]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'empty.txt');
  assert.equal(entries[0].size, 0);
  assert.equal(entries[0].data.length, 0);
  assert.deepEqual(entries[0].data, Buffer.alloc(0));
});

test('store: true 的条目 method 为 0 且内容一致', () => {
  const data = makeBytes(777, 42);
  const entries = readZip(writeZip([{ name: 'stored.bin', data, store: true }]));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].method, 0);
  assert.equal(entries[0].compressedSize, entries[0].size);
  assert.equal(entries[0].size, 777);
  assert.deepEqual(entries[0].data, data);
});

test('多条目顺序、内容与 zipStats 统计正确', () => {
  const json = JSON.stringify({ n: 1, 中文: true });
  const binary = makeBytes(1024, 7);
  const inputs = [
    { name: 'a.txt', data: 'aaa' },
    { name: 'dir/b.json', data: json },
    { name: 'dir/c.bin', data: binary, store: true },
  ];

  const zip = writeZip(inputs);
  const entries = readZip(zip);

  assert.deepEqual(entries.map((entry) => entry.name), ['a.txt', 'dir/b.json', 'dir/c.bin']);
  assert.equal(entries[0].data.toString('utf8'), 'aaa');
  assert.equal(entries[1].data.toString('utf8'), json);
  assert.deepEqual(entries[2].data, binary);

  const stats = zipStats(zip);
  assert.equal(stats.entries, 3);
  assert.equal(stats.bytes, 3 + Buffer.byteLength(json, 'utf8') + 1024);
  assert.deepEqual(stats.names, ['a.txt', 'dir/b.json', 'dir/c.bin']);
});

test('safeJoin 拒绝穿越、绝对路径、盘符，接受正常路径', () => {
  const root = path.resolve('test-sandbox-root');

  for (const bad of ['../../evil', '/etc/passwd', 'C:\\windows\\x', 'a/../../b', '..\\..\\evil', '..']) {
    assert.throws(() => safeJoin(root, bad), Error, `应拒绝: ${bad}`);
  }

  assert.equal(
    safeJoin(root, 'packages/插件名/lib/index.js'),
    path.join(root, 'packages', '插件名', 'lib', 'index.js'),
  );
  assert.equal(safeJoin(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(safeJoin(root, './a/./b.txt'), path.join(root, 'a', 'b.txt'));
});

test('二次读写（readZip → writeZip → readZip）结果稳定', () => {
  const first = writeZip([
    { name: 'one.txt', data: '第一个条目' },
    { name: 'dir/two.bin', data: makeBytes(256, 99), store: true },
  ]);
  const once = readZip(first);
  const second = writeZip(
    once.map((entry) => ({ name: entry.name, data: entry.data, store: entry.method === 0 })),
  );
  const twice = readZip(second);

  assert.deepEqual(
    twice.map((entry) => ({ name: entry.name, method: entry.method, data: entry.data })),
    once.map((entry) => ({ name: entry.name, method: entry.method, data: entry.data })),
  );
});

test('支持带 bit 3（data descriptor）的 zip', () => {
  const data = Buffer.from('data descriptor 条目内容', 'utf8');
  const entries = readZip(buildDataDescriptorZip('dd.txt', data));

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'dd.txt');
  assert.equal(entries[0].method, 8);
  assert.deepEqual(entries[0].data, data);
});

test('不支持的压缩方式抛中文错误', () => {
  const zip = writeZip([{ name: 'x.txt', data: 'hello' }]);
  const broken = Buffer.from(zip);
  broken.writeUInt16LE(12, 8); // local header 的 method
  const centralOffset = broken.readUInt32LE(broken.length - 22 + 16);
  broken.writeUInt16LE(12, centralOffset + 10); // central directory 的 method

  assert.throws(() => readZip(broken), /不支持的压缩方式: 12 \(x\.txt\)/);
});

test('ZIP64 标记抛“不支持 ZIP64”', () => {
  const zip = writeZip([{ name: 'x.txt', data: 'hello' }]);
  const broken = Buffer.from(zip);
  broken.writeUInt16LE(0xffff, broken.length - 22 + 10); // EOCD 总条目数改成 0xFFFF

  assert.throws(() => readZip(broken), /不支持 ZIP64/);
});

test('解析失败抛中文错误，不静默返回空数组', () => {
  assert.throws(() => readZip(Buffer.alloc(0)), /ZIP 解析失败/);
  assert.throws(() => readZip(Buffer.from('this is not a zip file at all')), /ZIP 解析失败/);
});

test('空 zip：writeZip([]) 可被读取与统计', () => {
  const zip = writeZip([]);

  assert.deepEqual(readZip(zip), []);
  assert.deepEqual(zipStats(zip), { entries: 0, bytes: 0, names: [] });
});

test('zipStats 不解压：压缩数据损坏时仍能统计', () => {
  const zip = writeZip([{ name: 'x.txt', data: 'hello world hello world' }]);
  const broken = Buffer.from(zip);
  const nameLength = broken.readUInt16LE(26);
  const extraLength = broken.readUInt16LE(28);
  broken[30 + nameLength + extraLength] ^= 0xff; // 破坏第一个压缩字节

  const stats = zipStats(broken);
  assert.equal(stats.entries, 1);
  assert.deepEqual(stats.names, ['x.txt']);
  assert.throws(() => readZip(broken), /ZIP (解压|校验)失败/);
});
