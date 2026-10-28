/**
 * npm tarball（.tgz）导出：单个插件用这种格式。
 *
 * 为什么不沿用整合包的 zip：
 *   - tarball 是 npm 生态的标准单包格式，别人拿到能直接 `npm i ./x.tgz`
 *   - 目录必须叫 `package/`，包里放 package.json 就是完整的一个 npm 包
 *   - gzip 压缩，比 zip 通常还小一点
 *
 * 格式细节（按 npm pack 的产出）：
 *   package/package.json
 *   package/<其余文件按原相对路径>
 *   package/node_modules/<dep>/...   扁平化依赖，装上就能跑
 *
 * tar 结构：每个文件 512 字节头 + 内容（向上取整到 512），最后两个全零块。
 *
 * @module dsh-plugin-pack/tar
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** tar 头部长度。 */
const BLOCK = 512;

/** 写入定长字符串字段（以 NUL 补齐）。 */
function writeString(header, offset, value, length) {
  const buf = Buffer.from(String(value ?? ''), 'utf8').subarray(0, length);
  buf.copy(header, offset);
}

/**
 * 写入八进制数字字段。
 *
 * @param {Buffer} header
 * @param {number} offset
 * @param {number} value
 * @param {number} length 含结尾 NUL 的字段长度
 */
function writeOctal(header, offset, value, length) {
  const text = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  writeString(header, offset, `${text}\0`, length);
}

/**
 * 求字符串字段的校验和（所有字节相加）。
 *
 * @param {Buffer} header
 * @returns {string} 6 位八进制 + NUL + 空格
 */
function checksumOf(header) {
  let sum = 0;
  for (const byte of header) sum += byte;
  return `${sum.toString(8).padStart(6, '0')}\0 `;
}

/**
 * 构造一个文件的 tar 头。
 *
 * @param {object} options
 * @param {string} options.name 归档内路径（如 package/package.json）
 * @param {number} options.size 字节数
 * @param {number} [options.mode] 权限位
 * @param {number} [options.mtime] 秒级时间戳
 * @param {'0'|'5'} [options.type] '0'=普通文件，'5'=目录
 * @returns {Buffer} 512 字节
 */
export function tarHeader({ name, size, mode = 0o644, mtime = 0, type = '0' }) {
  const header = Buffer.alloc(BLOCK);
  const fullName = String(name);
  const nameBytes = Buffer.byteLength(fullName, 'utf8');

  if (nameBytes <= 100) {
    writeString(header, 0, fullName, 100);
  } else {
    // 超长：拆成 prefix(<=155) + name(<=100)。
    // 从右往左找第一个能让"后半段 <=100 字节、前半段 <=155 字节"的 '/'。
    const chars = [...fullName];
    let splitAt = -1;
    for (let i = chars.length - 1; i > 0; i -= 1) {
      if (chars[i] !== '/') continue;
      const base = chars.slice(i + 1).join('');
      const prefix = chars.slice(0, i).join('');
      if (!base) continue;
      if (Buffer.byteLength(base, 'utf8') <= 100 && Buffer.byteLength(prefix, 'utf8') <= 155) {
        splitAt = i;
        break;
      }
    }
    if (splitAt < 0) {
      throw new Error(`归档路径过长（tar 极限 name≤100 + prefix≤155 字节），无法写入: ${fullName}`);
    }
    writeString(header, 345, chars.slice(0, splitAt).join(''), 155);
    writeString(header, 0, chars.slice(splitAt + 1).join(''), 100);
  }

  writeOctal(header, 100, mode, 8);
  writeOctal(header, 108, 0, 8); // uid
  writeOctal(header, 116, 0, 8); // gid
  writeOctal(header, 124, size, 12);
  writeOctal(header, 136, Math.floor(mtime / 1000), 12);
  writeString(header, 148, '        ', 8); // 校验和字段先填空格
  writeString(header, 156, type, 1);
  writeString(header, 257, 'ustar\0', 6);
  writeString(header, 263, '00', 2);
  writeString(header, 265, 'root', 32);
  writeString(header, 297, 'root', 32);
  writeString(header, 329, '0000000', 8);
  writeString(header, 337, '0000000', 8);
  header.write(checksumOf(header), 148, 'ascii');
  return header;
}

/** 把长度补齐到 512 的整数倍。 */
function padding(size) {
  const rest = size % BLOCK;
  return rest === 0 ? 0 : BLOCK - rest;
}

/**
 * 把条目流写成 .tgz（异步）。
 *
 * 两个"不能同步"的理由：
 *   1. `gzipSync` 会卡死整个事件循环 —— 实测 64 MiB 同步 gzip 期间
 *      定时器一次都没触发。dsh 的对话等请求全在同一个循环里，会一起卡住。
 *   2. 大插件的 tar 可能有几百 MiB，Buffer.concat 会翻倍峰值内存。
 *
 * 所以：tar 块直接管道进 zlib 的 gzip 流，边压边写盘。
 *
 * @param {Iterable<{name: string, file?: string, data?: Buffer|string}>|AsyncIterable<any>} entries
 * @param {string} outFile
 * @param {{ maxBytes?: number, mtime?: number }} [options]
 * @returns {Promise<{ bytes: number, entries: number, rawBytes: number }>}
 */
export async function writeTgzStream(entries, outFile, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? Math.floor(options.maxBytes) : Infinity;
  const mtime = Number.isFinite(options.mtime) ? options.mtime : Date.now();

  const outDir = path.dirname(path.resolve(outFile));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const out = fs.createWriteStream(outFile);
  const gzip = zlib.createGzip({ level: 9 });
  gzip.pipe(out);

  let count = 0;
  let raw = 0;
  let compressed = 0;
  out.on('data', () => {});
  // 统计压缩后大小
  const onGzipData = (chunk) => {
    compressed += chunk.length;
  };
  gzip.on('data', onGzipData);

  /** 等 gzip 流把数据吞下去（尊重背压）。 */
  const writeChunk = (buffer) =>
    new Promise((resolve, reject) => {
      raw += buffer.length;
      if (raw > maxBytes) {
        const error = new Error(`归档超过体积上限（已到 ${(raw / 1048576).toFixed(1)} MiB）`);
        error.code = 'TOO_LARGE';
        reject(error);
        return;
      }
      if (gzip.write(buffer)) resolve();
      else gzip.once('drain', resolve);
    });

  const finished = new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });

  try {
    for await (const item of entries) {
      if (!item || typeof item.name !== 'string' || !item.name) {
        throw new Error('writeTgzStream: 条目缺少 name');
      }
      const name = String(item.name).replace(/\\/g, '/').replace(/^\/+/, '');
      const data = item.file ? await fs.promises.readFile(item.file) : toBuf(item.data);
      await writeChunk(tarHeader({ name, size: data.length, mtime }));
      await writeChunk(data);
      const pad = padding(data.length);
      if (pad) await writeChunk(Buffer.alloc(pad));
      count += 1;
    }
    // tar 结尾：两个全零块
    await writeChunk(Buffer.alloc(BLOCK));
    await writeChunk(Buffer.alloc(BLOCK));
  } finally {
    gzip.end();
  }

  await finished;
  gzip.off('data', onGzipData);
  return { bytes: compressed, entries: count, rawBytes: raw };
}

/** 统一输入类型。 */
function toBuf(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`writeTgzStream: 不支持的数据类型 ${Object.prototype.toString.call(value)}`);
}

/**
 * 读 .tgz 的条目（测试和导入校验用）。
 *
 * @param {Buffer} buffer
 * @returns {Array<{ name: string, data: Buffer }>}
 */
export function readTgz(buffer) {
  const tar = zlib.gunzipSync(buffer);
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    // 全零块 = 结束
    if (header.every((byte) => byte === 0)) break;

    const rawName = header.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const sizeText = header.toString('utf8', 124, 136).replace(/\0.*$/, '').trim();
    const size = sizeText ? parseInt(sizeText, 8) : 0;
    const type = header.toString('utf8', 156, 157);

    offset += BLOCK;
    if (type === '0' || type === '\0' || type === '') {
      entries.push({ name, data: Buffer.from(tar.subarray(offset, offset + size)) });
      offset += size + padding(size);
    } else {
      // 目录等非普通文件：跳过
      offset += size + padding(size);
    }
  }
  return entries;
}
