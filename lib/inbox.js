/**
 * 拖放进来的文件/目录落盘。
 *
 * 浏览器的安全模型拿不到绝对路径，拖进来只有文件名和内容。
 * 所以界面把内容发上来，宿主写到临时目录，再走已有的导入流程：
 *
 *   zip  → $DSH_HOME/plugin-pack/inbox/<时间戳>/<原名>.zip → importBundle
 *   目录 → $DSH_HOME/plugin-pack/inbox/<时间戳>/<目录名>/... → importLocalPlugin
 *
 * 用 multipart/form-data 而不是 base64 JSON：几百 MB 的包不能膨胀 33%。
 *
 * @module dsh-plugin-pack/inbox
 */
import fs from 'node:fs';
import path from 'node:path';

import { stamp } from './home.js';
import { ensureDir, removeTree } from './util.js';

/** 单次落盘上限（默认 1 GiB，够大包也够防呆）。 */
const MAX_BYTES = 1024 * 1024 * 1024;

/**
 * 从 multipart/form-data 里解析出文件条目。
 *
 * 只实现够用的一部分：单层 boundary、每个 part 有 name/filename、内容不二次解码。
 * 不引第三方库。
 *
 * @param {Buffer} body 整个请求体
 * @param {string} boundary boundary 字符串（不含前置 --）
 * @returns {Array<{ name: string, filename: string|null, data: Buffer }>}
 */
export function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = 0;

  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    const afterHead = start + delimiter.length;
    // 结束标记 --boundary--
    if (body[afterHead] === 0x2d && body[afterHead + 1] === 0x2d) break;

    // 跳过分隔符后的 CRLF
    let headStart = afterHead;
    while (headStart < body.length && (body[headStart] === 0x0d || body[headStart] === 0x0a)) headStart += 1;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headStart);
    if (headerEnd < 0) break;

    const headerText = body.toString('utf8', headStart, headerEnd);
    const dataStart = headerEnd + 4;

    const next = body.indexOf(delimiter, dataStart);
    if (next < 0) break;

    // 数据到下一个分隔符前，去掉尾部 CRLF
    let dataEnd = next;
    if (dataEnd >= 2 && body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    parts.push({
      name: nameMatch ? nameMatch[1] : '',
      filename: fileMatch ? fileMatch[1] : null,
      data: body.subarray(dataStart, dataEnd),
    });

    cursor = next;
  }

  return parts;
}

/** 从请求里取 boundary。 */
export function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType ?? ''));
  if (!match) return null;
  return (match[1] ?? match[2] ?? '').trim();
}

/**
 * 把一个上传的 zip 落到 inbox，返回绝对路径。
 *
 * @param {object} options
 * @param {string} options.home $DSH_HOME
 * @param {string} options.filename 原始文件名
 * @param {Buffer} options.data 内容
 * @returns {{ file: string, bytes: number }}
 */
export function saveIncomingZip({ home, filename, data }) {
  if (!data?.length) {
    const error = new Error('上传内容为空');
    error.code = 'BAD_UPLOAD';
    throw error;
  }
  if (data.length > MAX_BYTES) {
    const error = new Error(`文件太大: ${(data.length / 1048576).toFixed(0)} MiB`);
    error.code = 'TOO_LARGE';
    throw error;
  }
  const base = safeName(String(filename ?? '').trim() || `bundle-${stamp()}.zip`);
  const dir = path.join(home, 'plugin-pack', 'inbox', stamp());
  ensureDir(dir);
  // 保留原始扩展名：.zip = 整合包，.tgz/.tar.gz = 单个插件的 npm tarball
  const lower = base.toLowerCase();
  const hasKnownExt = lower.endsWith('.zip') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz');
  const file = path.join(dir, hasKnownExt ? base : `${base}.zip`);
  fs.writeFileSync(file, data);
  return { file, bytes: data.length };
}

/**
 * 把一个上传的目录（多文件 + 相对路径）落到 inbox，返回目录绝对路径。
 *
 * @param {object} options
 * @param {string} options.home
 * @param {string} options.rootName 拖进来的目录名
 * @param {Array<{ rel: string, data: Buffer }>} options.files
 * @returns {{ dir: string, files: number, bytes: number }}
 */
export function saveIncomingDir({ home, rootName, files }) {
  if (!Array.isArray(files) || !files.length) {
    const error = new Error('目录里没有文件');
    error.code = 'BAD_UPLOAD';
    throw error;
  }
  const root = safeName(String(rootName ?? '').trim() || `plugin-${stamp()}`);
  const dir = path.join(home, 'plugin-pack', 'inbox', stamp(), root);
  ensureDir(dir);

  let bytes = 0;
  let count = 0;
  const base = path.resolve(dir);
  for (const item of files) {
    let rel = String(item.rel ?? '').replace(/\\/g, '/');
    if (!rel || rel.includes('\0')) continue;
    // 拖目录时 rel 通常已带根目录名（my-plugin/lib/x.js）；
    // 如果第一段就是 root，去掉它，避免 my-plugin/my-plugin/lib/x.js
    const segmentsAll = rel.split('/').filter(Boolean);
    if (segmentsAll.length && segmentsAll[0] === root) segmentsAll.shift();
    if (!segmentsAll.length) continue;
    if (segmentsAll.some((seg) => seg === '..' || seg === '.')) continue; // 防穿越
    const target = path.join(base, ...segmentsAll);
    if (!path.resolve(target).startsWith(base)) continue;
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, item.data);
    bytes += item.data.length;
    count += 1;
    if (bytes > MAX_BYTES) {
      removeTree(dir);
      const error = new Error('目录太大');
      error.code = 'TOO_LARGE';
      throw error;
    }
  }
  return { dir, files: count, bytes };
}

/** 文件/目录名去危险字符。 */
function safeName(name) {
  return (
    String(name)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\.\./g, '_')
      .slice(0, 120) || `item-${stamp()}`
  );
}

/** 清掉超过 N 天的 inbox（避免临时目录越攒越多）。 */
export function pruneInbox(home, days = 7) {
  const root = path.join(home, 'plugin-pack', 'inbox');
  let removed = 0;
  try {
    const now = Date.now();
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > days * 86400000) {
          removeTree(full);
          removed += 1;
        }
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* inbox 还不存在 */
  }
  return removed;
}
