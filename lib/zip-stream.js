/**
 * 流式写 ZIP。
 *
 * 为什么单独做：默认导出的插件集合在真实 profile 上是几百 MiB，
 * 用 writeZip（Buffer.concat 全部条目）峰值内存会翻倍。
 *
 * 关键设计：**全程异步**。
 *   压缩用 zlib 的 callback 版本而不是 `deflateRawSync` —— 同步压缩会
 *   把整个 Node 事件循环卡住，导致 dsh 的对话、其它接口全部无响应。
 *   实测 64 MiB 同步 gzip 耗时 413ms，期间定时器一次都没触发。
 *   导出几百 MiB 就是好几秒的完全冻结，所以这里必须异步。
 *
 * 写盘也用 fs.promises，让出事件循环给其它请求。
 *
 * @module dsh-plugin-pack/lib/zip-stream
 */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw as deflateRawCb } from 'node:zlib';

import { crc32 } from './zip.js';

const deflateRaw = promisify(deflateRawCb);

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01

/** 已压缩过的条目：再 deflate 一遍几乎没有收益，直接 store。 */
const ALREADY_COMPRESSED = /\.(tgz|tar\.gz|gz|zip|7z|br|xz|png|jpg|jpeg|webp|mp4|webm|woff2?)$/i;

/**
 * 把条目流写成 zip 文件（异步）。
 *
 * @param {Iterable<{name: string, data?: Buffer|Uint8Array|string, file?: string, store?: boolean}>|AsyncIterable<any>} entries
 * @param {string} outFile
 * @param {{ maxBytes?: number, onEntry?: (name: string, bytes: number) => void }} [options]
 * @returns {Promise<{ bytes: number, entries: number }>}
 */
export async function writeZipStream(entries, outFile, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : Infinity;
  const onEntry = typeof options.onEntry === 'function' ? options.onEntry : () => {};

  // 只在目录不存在时才创建（对已存在的盘符根 mkdir 会 EPERM）
  const outDir = path.dirname(path.resolve(outFile));
  if (!fs.existsSync(outDir)) await fs.promises.mkdir(outDir, { recursive: true });

  const handle = await fs.promises.open(outFile, 'w');
  /** @type {Buffer[]} 中央目录分片（只有 header + 文件名，很小） */
  const centralParts = [];
  let offset = 0;
  let count = 0;
  let total = 0;

  const write = async (buffer) => {
    await handle.write(buffer);
    offset += buffer.length;
  };

  try {
    for await (const item of entries) {
      if (!item || typeof item.name !== 'string' || !item.name) {
        throw new Error('writeZipStream: 条目缺少 name');
      }
      const name = item.name.replace(/\\/g, '/');
      if (name.endsWith('/')) continue;
      if (name.includes('\0')) throw new Error(`writeZipStream: 条目名含 NUL: ${item.name}`);

      const data = item.file ? await fs.promises.readFile(item.file) : toBuf(item.data);
      const nameBuf = Buffer.from(name, 'utf8');
      if (nameBuf.length > U16_MAX) throw new Error(`writeZipStream: 条目名过长: ${name}`);
      if (data.length > U32_MAX || offset > U32_MAX) throw new Error('不支持 ZIP64');

      const store = item.store === true || (item.store === undefined && ALREADY_COMPRESSED.test(name));
      const method = store ? METHOD_STORE : METHOD_DEFLATE;
      // 异步压缩：让出事件循环，宿主还能处理对话等其它请求
      const payload = store ? data : await deflateRaw(data, { level: 9 });
      const checksum = crc32(data);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(FLAG_UTF8, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(payload.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(SIG_CENTRAL, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(FLAG_UTF8, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(DOS_TIME, 12);
      central.writeUInt16LE(DOS_DATE, 14);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(payload.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(0, 30); // extra
      central.writeUInt16LE(0, 32); // comment
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE(0, 38);
      central.writeUInt32LE(offset, 42);

      await write(local);
      await write(nameBuf);
      await write(payload);

      centralParts.push(central, nameBuf);
      count += 1;
      total += data.length;
      if (count > U16_MAX) throw new Error('不支持 ZIP64');
      if (total > maxBytes) {
        const error = new Error(
          `整合包超过体积上限（已到 ${(total / 1048576).toFixed(1)} MiB，上限 ${(maxBytes / 1048576).toFixed(1)} MiB）`,
        );
        error.code = 'TOO_LARGE';
        throw error;
      }
      onEntry(name, data.length);
    }

    const centralStart = offset;
    for (const part of centralParts) await write(part);
    const centralSize = offset - centralStart;

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(centralSize, 12);
    eocd.writeUInt32LE(centralStart, 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    return { bytes: offset, entries: count };
  } finally {
    await handle.close();
  }
}

/** 统一输入类型。 */
function toBuf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`writeZipStream: 不支持的数据类型 ${Object.prototype.toString.call(value)}`);
}
