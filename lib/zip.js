/**
 * 零依赖 ZIP 读写模块。
 *
 * 只使用 node: 内置模块（node:zlib / node:path），不引入 fflate、archiver、jszip、yauzl 等第三方库。
 *
 * 支持范围：
 * - 写入：method 0（store）与 method 8（deflate，level 9）；通用标志位 bit 11（UTF-8 文件名）；
 *   不写 data descriptor，CRC 与长度直接写进 local file header。
 * - 读取：以 EOCD → central directory 为准，不顺序扫 local header；支持 method 0 / 8；
 *   支持带 bit 3（data descriptor）的 zip，长度与 CRC 取自 central directory；
 *   目录条目（name 以 `/` 结尾）直接跳过。
 *
 * 明确不支持：ZIP64、分卷、加密条目，以及 method 12（bzip2）、14（lzma）、99（AES）等压缩方式。
 *
 * @module dsh-plugin-pack/lib/zip
 */

import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/** local file header 签名 `PK\x03\x04`。 */
const SIG_LOCAL = 0x04034b50;
/** central directory file header 签名 `PK\x01\x02`。 */
const SIG_CENTRAL = 0x02014b50;
/** end of central directory 签名 `PK\x05\x06`。 */
const SIG_EOCD = 0x06054b50;

/** 通用标志位 bit 11：文件名使用 UTF-8。 */
const FLAG_UTF8 = 0x0800;
/** 通用标志位 bit 0：条目已加密。 */
const FLAG_ENCRYPTED = 0x0001;

/** 压缩方式：原样存储。 */
const METHOD_STORE = 0;
/** 压缩方式：deflate。 */
const METHOD_DEFLATE = 8;

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

/** 固定 DOS 时间戳 1980-01-01 00:00:00，保证输出字节可复现。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** ZIP64 统一错误文案。 */
const ERR_ZIP64 = '不支持 ZIP64';

/**
 * @typedef {Object} ZipEntryInput
 * @property {string} name 条目路径，写入时统一用 `/` 分隔
 * @property {Buffer|Uint8Array|ArrayBuffer|string} data 条目内容
 * @property {boolean} [store] 为 true 时用 method 0 原样存储，否则 deflate
 */

/**
 * @typedef {Object} ZipEntry
 * @property {string} name 条目路径
 * @property {Buffer} data 解压后的内容
 * @property {number} method 压缩方式（0 或 8）
 * @property {number} compressedSize 压缩后字节数
 * @property {number} size 原始字节数
 */

/**
 * @typedef {Object} ZipCentralRecord
 * @property {string} name 条目路径
 * @property {number} flags 通用标志位
 * @property {number} method 压缩方式
 * @property {number} checksum central directory 中记录的 CRC-32
 * @property {number} compressedSize 压缩后字节数
 * @property {number} size 原始字节数
 * @property {number} localOffset local file header 的偏移
 */

/**
 * CRC-32（IEEE 802.3，多项式 0xEDB88320）查表，模块加载时算一次。
 *
 * @type {Uint32Array}
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/**
 * 把任意受支持的输入统一成 Buffer（不复制已有 Buffer）。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} value
 * @returns {Buffer}
 */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`不支持的数据类型: ${Object.prototype.toString.call(value)}`);
}

/**
 * 计算 CRC-32（unsigned 32-bit）。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer|string} buffer 待计算的数据
 * @returns {number} 0 ~ 0xFFFFFFFF 的整数
 */
export function crc32(buffer) {
  const buf = toBuffer(buffer);
  let crc = 0xffffffff;
  for (let index = 0; index < buf.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buf[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 生成一个完整的 ZIP 文件。
 *
 * 结构：local file header + data（逐条）+ central directory + EOCD。
 * 所有字段按 ZIP 规范小端序写入；不写 data descriptor；空目录条目跳过。
 *
 * @param {ZipEntryInput[]} entries 条目列表
 * @returns {Buffer} 完整 zip 字节
 */
export function writeZip(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('writeZip: entries 必须是数组');
  }

  /** @type {Buffer[]} local header / 文件名 / 数据分片，最后一次性拼接。 */
  const localParts = [];
  /** @type {Buffer[]} central directory 分片。 */
  const centralParts = [];
  let offset = 0;
  let count = 0;

  for (const raw of entries) {
    if (raw === null || typeof raw !== 'object') {
      throw new Error('writeZip: 每个条目必须是对象');
    }
    if (typeof raw.name !== 'string' || raw.name.length === 0) {
      throw new Error('writeZip: 条目缺少非空的 name');
    }
    const name = raw.name.replace(/\\/g, '/');
    if (name.includes('\0')) {
      throw new Error(`writeZip: 条目名包含 NUL 字符: ${raw.name}`);
    }
    // 目录条目（name 以 / 结尾）不写入，读取侧同样会跳过。
    if (name.endsWith('/')) continue;
    if (raw.data === undefined || raw.data === null) {
      throw new Error(`writeZip: 条目缺少 data: ${name}`);
    }

    const data = toBuffer(raw.data);
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > U16_MAX) {
      throw new Error(`writeZip: 条目名过长: ${name}`);
    }
    if (data.length > U32_MAX) {
      throw new Error(ERR_ZIP64);
    }
    if (offset > U32_MAX) {
      throw new Error(ERR_ZIP64);
    }

    const store = raw.store === true;
    const method = store ? METHOD_STORE : METHOD_DEFLATE;
    const payload = store ? data : deflateRawSync(data, { level: 9 });
    if (payload.length > U32_MAX) {
      throw new Error(ERR_ZIP64);
    }
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed to extract: 2.0
    local.writeUInt16LE(FLAG_UTF8, 6); // bit 11: UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field 长度

    localParts.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by: MS-DOS, 2.0
    central.writeUInt16LE(20, 6); // version needed to extract: 2.0
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field 长度
    central.writeUInt16LE(0, 32); // comment 长度
    central.writeUInt16LE(0, 34); // 起始磁盘号
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42); // local header 偏移

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
    count += 1;
  }

  if (count > U16_MAX) {
    throw new Error(ERR_ZIP64);
  }
  if (offset > U32_MAX) {
    throw new Error(ERR_ZIP64);
  }

  const central = Buffer.concat(centralParts);
  if (central.length > U32_MAX) {
    throw new Error(ERR_ZIP64);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 当前磁盘号
  eocd.writeUInt16LE(0, 6); // central directory 起始磁盘号
  eocd.writeUInt16LE(count, 8); // 本磁盘条目数
  eocd.writeUInt16LE(count, 10); // 总条目数
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment 长度

  return Buffer.concat([...localParts, central, eocd]);
}

/**
 * 从尾部向前定位 EOCD，优先返回注释长度与文件尾严格对齐的那条记录。
 *
 * @param {Buffer} buf
 * @returns {number} EOCD 起始偏移
 */
function findEocd(buf) {
  if (buf.length < 22) {
    throw new Error('ZIP 解析失败: 文件长度不足，缺少 EOCD 记录');
  }
  const lowest = Math.max(0, buf.length - 22 - U16_MAX);
  let loose = -1;
  for (let index = buf.length - 22; index >= lowest; index -= 1) {
    if (buf.readUInt32LE(index) !== SIG_EOCD) continue;
    const commentLength = buf.readUInt16LE(index + 20);
    if (index + 22 + commentLength === buf.length) return index;
    if (loose === -1 && index + 22 + commentLength <= buf.length) loose = index;
  }
  if (loose !== -1) return loose;
  throw new Error('ZIP 解析失败: 找不到 EOCD 记录');
}

/**
 * 读取并校验 EOCD 字段（含 ZIP64 / 分卷检查）。
 *
 * @param {Buffer} buf
 * @returns {{ totalEntries: number, centralSize: number, centralOffset: number }}
 */
function readEocd(buf) {
  const eocd = findEocd(buf);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (
    totalEntries === U16_MAX ||
    entriesOnDisk === U16_MAX ||
    centralSize === U32_MAX ||
    centralOffset === U32_MAX
  ) {
    throw new Error(ERR_ZIP64);
  }
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error('不支持分卷 ZIP');
  }
  if (centralOffset + centralSize > buf.length) {
    throw new Error('ZIP 解析失败: central directory 超出文件范围');
  }
  return { totalEntries, centralSize, centralOffset };
}

/**
 * 解析 central directory，返回文件条目（跳过目录条目）。
 *
 * 只读取元数据，不做任何解压，供 readZip / zipStats 共用。
 *
 * @param {Buffer} buf
 * @returns {ZipCentralRecord[]}
 */
function parseCentralDirectory(buf) {
  const { totalEntries, centralSize, centralOffset } = readEocd(buf);
  const centralEnd = centralOffset + centralSize;
  /** @type {ZipCentralRecord[]} */
  const records = [];
  let cursor = centralOffset;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > centralEnd) {
      throw new Error(`ZIP 解析失败: central directory 第 ${index + 1} 条记录被截断`);
    }
    if (buf.readUInt32LE(cursor) !== SIG_CENTRAL) {
      throw new Error(`ZIP 解析失败: central directory 第 ${index + 1} 条记录签名错误`);
    }

    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const checksum = buf.readUInt32LE(cursor + 16);
    const compressedSize = buf.readUInt32LE(cursor + 20);
    const size = buf.readUInt32LE(cursor + 24);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;

    if (next > centralEnd) {
      throw new Error(`ZIP 解析失败: central directory 第 ${index + 1} 条记录越界`);
    }
    if (compressedSize === U32_MAX || size === U32_MAX || localOffset === U32_MAX) {
      throw new Error(ERR_ZIP64);
    }

    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor = next;

    // 目录条目直接跳过，不返回。
    if (name.endsWith('/')) continue;

    records.push({ name, flags, method, checksum, compressedSize, size, localOffset });
  }

  return records;
}

/**
 * 读取 ZIP 的条目元数据，**不解压任何数据**。
 *
 * 大包（几百 MB）用它先拿到清单，再用 extractEntry 逐条解压写盘，
 * 峰值内存只有单个文件，而不是整包。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer zip 字节
 * @returns {ZipCentralRecord[]} 文件条目（已跳过目录条目）
 */
export function readZipMeta(buffer) {
  const buf = toBuffer(buffer);
  return parseCentralDirectory(buf);
}

/**
 * 从 zip 里解出单条记录的内容。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer zip 字节
 * @param {ZipCentralRecord} record readZipMeta 返回的记录
 * @returns {Buffer} 解压后的内容
 */
export function extractEntry(buffer, record) {
  const buf = toBuffer(buffer);
  if ((record.flags & FLAG_ENCRYPTED) !== 0) {
    throw new Error(`不支持加密条目: ${record.name}`);
  }
  if (record.method !== METHOD_STORE && record.method !== METHOD_DEFLATE) {
    throw new Error(`不支持的压缩方式: ${record.method} (${record.name})`);
  }

  const local = record.localOffset;
  if (local + 30 > buf.length) {
    throw new Error(`ZIP 解析失败: 条目 local header 越界 (${record.name})`);
  }
  if (buf.readUInt32LE(local) !== SIG_LOCAL) {
    throw new Error(`ZIP 解析失败: 条目 local header 签名错误 (${record.name})`);
  }

  const nameLength = buf.readUInt16LE(local + 26);
  const extraLength = buf.readUInt16LE(local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > buf.length) {
    throw new Error(`ZIP 解析失败: 条目数据越界 (${record.name})`);
  }
  const raw = buf.subarray(dataStart, dataEnd);

  /** @type {Buffer} */
  let data;
  if (record.method === METHOD_STORE) {
    if (record.compressedSize !== record.size) {
      throw new Error(`ZIP 解析失败: store 条目长度不一致 (${record.name})`);
    }
    data = Buffer.from(raw);
  } else if (record.compressedSize === 0 && record.size === 0) {
    data = Buffer.alloc(0);
  } else {
    try {
      data = inflateRawSync(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`ZIP 解压失败: ${record.name} (${reason})`);
    }
    if (data.length !== record.size) {
      throw new Error(`ZIP 解析失败: 解压后长度不一致 (${record.name})`);
    }
  }

  if (crc32(data) !== record.checksum) {
    throw new Error(`ZIP 校验失败: CRC 不匹配 (${record.name})`);
  }
  return data;
}

/**
 * 读取 ZIP 的全部文件条目。
 *
 * 数据位置按 central directory 记录的 local header 偏移与压缩长度截取，
 * 因此带 bit 3（data descriptor）的 zip 也能正确读取。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer zip 字节
 * @returns {ZipEntry[]}
 */
export function readZip(buffer) {
  const buf = toBuffer(buffer);
  const records = parseCentralDirectory(buf);
  /** @type {ZipEntry[]} */
  const entries = [];
  for (const record of records) {
    const data = extractEntry(buf, record);
    entries.push({
      name: record.name,
      data,
      method: record.method,
      compressedSize: record.compressedSize,
      size: record.size,
    });
  }
  return entries;
}

/**
 * 快速统计 zip：只解析 EOCD + central directory，不解压任何数据。
 *
 * @param {Buffer|Uint8Array|ArrayBuffer} buffer zip 字节
 * @returns {{ entries: number, bytes: number, names: string[] }} 条目数、原始字节总数、条目名
 */
export function zipStats(buffer) {
  const buf = toBuffer(buffer);
  const records = parseCentralDirectory(buf);
  const names = new Array(records.length);
  let bytes = 0;
  for (let index = 0; index < records.length; index += 1) {
    names[index] = records[index].name;
    bytes += records[index].size;
  }
  return { entries: records.length, bytes, names };
}

/**
 * 把 zip 内的条目名安全地拼到 root 目录下。
 *
 * 拒绝：以 `/` 或 `\` 开头的绝对路径、盘符开头（`C:`）、含 `..` 路径段、含 NUL 字符，
 * 以及 resolve 后逃出 root 的路径。
 *
 * @param {string} root 解压目标根目录
 * @param {string} name zip 条目名
 * @returns {string} root 之内的绝对路径
 */
export function safeJoin(root, name) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('safeJoin: root 必须是非空字符串');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('safeJoin: name 必须是非空字符串');
  }

  const normalized = name.replace(/\\/g, '/');
  if (normalized.includes('\0')) {
    throw new Error(`非法条目路径（包含 NUL 字符）: ${name}`);
  }
  if (normalized.startsWith('/')) {
    throw new Error(`非法条目路径（绝对路径）: ${name}`);
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    throw new Error(`非法条目路径（盘符）: ${name}`);
  }

  const segments = normalized.split('/');
  if (segments.includes('..')) {
    throw new Error(`非法条目路径（路径穿越）: ${name}`);
  }
  const cleaned = segments.filter((segment) => segment.length > 0 && segment !== '.');

  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...cleaned);
  const relative = path.relative(resolvedRoot, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`非法条目路径（逃出 root）: ${name}`);
  }
  return target;
}
