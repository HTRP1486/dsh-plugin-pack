/**
 * @file dsh `cordis.patch.yml` 的文本块级处理。
 *
 * 设计前提：**不解析 YAML**。只做两件事：
 *   1. 按「列 0 的 `- `」切顶层条目；
 *   2. 按缩进切 `- insert:` 的子条目。
 * 其余内容（注释、`!!js` 表达式、多行 config、缩进风格）一律逐字保留，
 * 因为用户手写的注释和表达式比结构化往返更重要。
 *
 * 行尾：只识别 LF（`\n`）与 CRLF（`\r\n`），不处理孤立 CR。
 * 顶层条目的 `raw` 含其上方紧邻的注释块（中间无空行），不含结尾多余空行。
 */

/** @typedef {{ start: number, end: number, content: string, eol: string, raw: string }} Line */

/**
 * 顶层条目。
 * @typedef {object} TopEntry
 * @property {string} raw 条目原文（含上方紧邻注释块，不含结尾多余空行）
 * @property {number} start 在原文中的起始字符偏移
 * @property {number} end 在原文中的结束字符偏移（不含）
 * @property {string|null} id 条目自身 id；insert 块为 null
 * @property {'row'|'insert'|'other'} kind 条目类型
 * @property {string[]} names 条目内出现的所有 `name:` 值（已去引号）
 * @property {boolean|null} disabled 仅 row 且显式 `disabled: true/false` 时有值，否则 null
 */

/**
 * insert 子条目。
 * @typedef {object} InsertChild
 * @property {string} raw 子条目原文（含上方紧邻注释块，不含结尾多余空行）
 * @property {string|null} id 子条目 id
 * @property {string[]} names 子条目内出现的所有 `name:` 值（已去引号）
 * @property {boolean|null} disabled 显式 `disabled: true/false` 时有值，否则 null
 */

/** 行首键：可选缩进 + 可选 `- ` + key + `:` + 剩余。 */
const KEY_RE = /^([ \t]*)(?:-[ \t]+)?([A-Za-z0-9_$@][A-Za-z0-9_$@.-]*)[ \t]*:(.*)$/;

/** 行首列表项：缩进 + `- ` + key + `:` + 剩余。 */
const HEAD_RE = /^([ \t]*)-([ \t]+)([A-Za-z0-9_$@][A-Za-z0-9_$@.-]*)[ \t]*:(.*)$/;

/** 可裸写的 plain scalar 字符集（首字符不能是 `@`、`-`、`#` 等指示符）。 */
const PLAIN_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/@]*$/;

/** YAML 1.1/1.2 里会被解释成布尔或 null 的裸值。 */
const RESERVED_RE = /^(?:true|false|yes|no|on|off|null|~|y|n)$/i;

/** 数字形（含下划线、指数），裸写会被解释成数字。 */
const NUMBER_RE = /^[+-]?\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?$/;

/** 日期/时间形，裸写会被解释成 timestamp。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ].*)?$/;

/**
 * 把文本切成带字符偏移的行。
 * @param {string} text 任意文本
 * @returns {Line[]} 行对象数组；空串返回空数组
 */
function scanLines(text) {
  /** @type {Line[]} */
  const lines = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      const raw = text.slice(start);
      lines.push({ start, end: text.length, content: raw, eol: '', raw });
      break;
    }
    const raw = text.slice(start, nl + 1);
    let content = raw.slice(0, -1);
    let eol = '\n';
    if (content.endsWith('\r')) {
      content = content.slice(0, -1);
      eol = '\r\n';
    }
    lines.push({ start, end: nl + 1, content, eol, raw });
    start = nl + 1;
  }
  return lines;
}

/**
 * 是否空白行（只含空格 / 制表符）。
 * @param {string} content 行内容（不含行尾）
 * @returns {boolean}
 */
function isBlank(content) {
  return content.trim() === '';
}

/**
 * 是否注释行（`#` 前只允许空白）。
 * @param {string} content 行内容（不含行尾）
 * @returns {boolean}
 */
function isComment(content) {
  return /^[ \t]*#/.test(content);
}

/**
 * 取一行的缩进宽度。
 * @param {string} content 行内容（不含行尾）
 * @returns {number}
 */
function indentOf(content) {
  const m = /^[ \t]*/.exec(content);
  return m ? m[0].length : 0;
}

/**
 * 探测换行风格：第一处 `\n` 前是 `\r` 则为 CRLF。
 * @param {string} text 任意文本
 * @returns {'\n'|'\r\n'}
 */
function detectEol(text) {
  const i = typeof text === 'string' ? text.indexOf('\n') : -1;
  if (i > 0 && text[i - 1] === '\r') return '\r\n';
  return '\n';
}

/**
 * 把文本里的所有换行统一成指定风格。
 * @param {string} text 任意文本
 * @param {'\n'|'\r\n'} eol 目标换行
 * @returns {string}
 */
function normalizeEol(text, eol) {
  return text.replace(/\r\n|\n|\r/g, eol);
}

/**
 * 从「冒号后面的原文」取出标量值，并返回剩余部分（通常是行尾注释）。
 * 只做一层引号 / 注释处理，不解析复杂结构。
 * @param {string} text 冒号后的原文
 * @returns {{ value: string, rest: string }} 去引号的值与剩余原文
 */
function takeScalar(text) {
  const s = String(text ?? '').trim();
  if (s.startsWith("'")) {
    let out = '';
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 1;
          continue;
        }
        return { value: out, rest: s.slice(i + 1) };
      }
      out += s[i];
    }
    return { value: out, rest: '' };
  }
  if (s.startsWith('"')) {
    let out = '';
    for (let i = 1; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length) {
        const nx = s[i + 1];
        out += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === 'r' ? '\r' : nx;
        i += 1;
        continue;
      }
      if (ch === '"') return { value: out, rest: s.slice(i + 1) };
      out += ch;
    }
    return { value: out, rest: '' };
  }
  const hash = s.search(/[ \t]#/);
  if (hash === -1) return { value: s, rest: '' };
  return { value: s.slice(0, hash).trim(), rest: s.slice(hash) };
}

/**
 * 把裸值按 YAML 规则判成布尔；不是布尔返回 null。
 * @param {string} text 冒号后的原文
 * @returns {boolean|null}
 */
function boolOf(text) {
  const v = takeScalar(text).value.toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * 判断条目类型。
 * @param {string} firstContent 条目的 `- ` 行内容（不含行尾）
 * @returns {'row'|'insert'|'other'}
 */
function kindOf(firstContent) {
  if (/^-[ \t]+insert[ \t]*:/.test(firstContent)) return 'insert';
  if (/^-[ \t]+id[ \t]*:/.test(firstContent)) return 'row';
  return 'other';
}

/**
 * 读取一个条目 / 子条目的元信息。
 * @param {Line[]} lines 条目所在的行数组
 * @param {number} from 条目 `- ` 行的下标（不含上方注释）
 * @param {number} to 条目结束行下标（不含）
 * @returns {{ id: string|null, names: string[], disabled: boolean|null, baseIndent: number, ownIndent: number }}
 */
function analyzeEntry(lines, from, to) {
  const head = HEAD_RE.exec(lines[from].content);
  const baseIndent = head ? head[1].length : 0;
  const ownIndent = head ? baseIndent + 1 + head[2].length : baseIndent + 2;
  /** @type {string[]} */
  const names = [];
  /** @type {string|null} */
  let id = null;
  /** @type {boolean|null} */
  let disabled = null;

  if (head) {
    if (head[3] === 'name') names.push(takeScalar(head[4]).value);
    if (head[3] === 'id') id = takeScalar(head[4]).value;
    if (head[3] === 'disabled') disabled = boolOf(head[4]);
  }

  for (let i = from + 1; i < to; i += 1) {
    const content = lines[i].content;
    if (isBlank(content) || isComment(content)) continue;
    const m = KEY_RE.exec(content);
    if (!m) continue;
    if (m[2] === 'name') {
      names.push(takeScalar(m[3]).value);
      continue;
    }
    if (m[1].length !== ownIndent) continue;
    if (m[2] === 'id' && id === null) id = takeScalar(m[3]).value;
    else if (m[2] === 'disabled') disabled = boolOf(m[3]);
  }

  return { id, names, disabled, baseIndent, ownIndent };
}

/**
 * 去掉结尾的空行（保留最后一个非空行自己的行尾）。
 * @param {string} text 待处理文本
 * @returns {string} 去掉结尾空行后的文本
 */
function trimBlankLines(text) {
  const lines = scanLines(text);
  let a = 0;
  let b = lines.length - 1;
  while (a <= b && isBlank(lines[a].content)) a += 1;
  while (b >= a && isBlank(lines[b].content)) b -= 1;
  if (a > b) return '';
  const slice = text.slice(lines[a].start, lines[b].end);
  return slice.endsWith('\r\n') ? slice.slice(0, -2) : slice.endsWith('\n') ? slice.slice(0, -1) : slice;
}

/**
 * 按列 0 的 `- ` 切顶层条目。
 *
 * 规则：
 * - 缩进行、空行不产生条目；
 * - 条目上方紧邻的注释块（中间没有空行）归入该条目的 `raw`；
 * - 条目 `raw` 不含结尾多余空行；
 * - 空文件、纯注释文件返回 `[]`。
 *
 * @param {string} text 整个 `cordis.patch.yml` 文本
 * @returns {TopEntry[]} 顶层条目数组（按出现顺序）
 * @throws {TypeError} 入参不是字符串时抛出
 */
export function splitTopLevel(text) {
  if (typeof text !== 'string') {
    throw new TypeError('splitTopLevel 需要字符串输入');
  }
  if (text.length === 0) return [];

  const lines = scanLines(text);
  /** @type {number[]} */
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].content.startsWith('- ')) starts.push(i);
  }
  if (starts.length === 0) return [];

  // 每个条目真正的起点：向上吃掉紧邻的注释行（遇到空行或非注释即停）。
  const blocks = starts.map((s) => {
    let b = s;
    while (b > 0 && isComment(lines[b - 1].content)) b -= 1;
    return b;
  });

  /** @type {TopEntry[]} */
  const entries = [];
  for (let k = 0; k < starts.length; k += 1) {
    const fromLine = blocks[k];
    const startLine = starts[k];
    const stopLine = k + 1 < starts.length ? blocks[k + 1] : lines.length;

    let lastLine = stopLine - 1;
    while (lastLine > startLine && isBlank(lines[lastLine].content)) lastLine -= 1;

    const start = lines[fromLine].start;
    const end = lines[lastLine].end;
    const kind = kindOf(lines[startLine].content);
    const meta = analyzeEntry(lines, startLine, stopLine);

    entries.push({
      raw: text.slice(start, end),
      start,
      end,
      id: kind === 'insert' ? null : meta.id,
      kind,
      names: meta.names,
      disabled: kind === 'row' ? meta.disabled : null,
    });
  }
  return entries;
}

/**
 * 从 insert 块的 `raw` 里拆出子条目（缩进 4 的 `- `）。
 *
 * 子条目上方紧邻的注释块（缩进 >= 4，中间没有空行）归入该子条目。
 *
 * @param {string} raw insert 块原文（`splitTopLevel` 得到的 `raw`）
 * @returns {InsertChild[]} 子条目数组
 * @throws {TypeError} 入参不是字符串时抛出
 */
export function splitInsertChildren(raw) {
  if (typeof raw !== 'string') {
    throw new TypeError('splitInsertChildren 需要字符串输入');
  }
  if (raw.length === 0) return [];

  const lines = scanLines(raw);
  /** @type {number[]} */
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^ {4}- /.test(lines[i].content)) starts.push(i);
  }
  if (starts.length === 0) return [];

  const blocks = starts.map((s) => {
    let b = s;
    while (b > 0 && isComment(lines[b - 1].content) && indentOf(lines[b - 1].content) >= 4) {
      b -= 1;
    }
    return b;
  });

  /** @type {InsertChild[]} */
  const children = [];
  for (let k = 0; k < starts.length; k += 1) {
    const startLine = starts[k];
    const stopLine = k + 1 < starts.length ? blocks[k + 1] : lines.length;
    let lastLine = stopLine - 1;
    while (lastLine > startLine && isBlank(lines[lastLine].content)) lastLine -= 1;

    const meta = analyzeEntry(lines, startLine, stopLine);
    children.push({
      raw: raw.slice(lines[blocks[k]].start, lines[lastLine].end),
      id: meta.id,
      names: meta.names,
      disabled: meta.disabled,
    });
  }
  return children;
}

/**
 * 把名字里的反斜杠统一成正斜杠，去掉结尾分隔符，便于跨平台比较。
 * @param {string} value 原始路径
 * @returns {string} 归一化后的路径（未做大小写处理）
 */
function normalizePath(value) {
  return String(value ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
}

/**
 * 判断某个顶层条目是否属于给定插件。
 *
 * 匹配规则（任一命中即可）：
 * 1. `entry.id === plugin.name`；
 * 2. `entry.names` 里有一项等于 `plugin.name`；
 * 3. `entry.names` 里有一项落在 `plugin.dirs` 的某个目录下（按 `/` 或 `\` 分段）。
 *
 * 路径比较忽略大小写（Windows 语义），id / name 的相等比较区分大小写。
 *
 * @param {TopEntry} entry `splitTopLevel` 的条目
 * @param {{ name: string, dirs?: string[] }} plugin 插件描述
 * @returns {boolean} 是否匹配
 */
export function entryMatchesPlugin(entry, plugin) {
  if (!entry || !plugin || typeof plugin.name !== 'string') return false;
  const name = plugin.name.trim();
  if (name === '') return false;

  if (entry.id !== null && entry.id !== undefined && entry.id === name) return true;

  const names = Array.isArray(entry.names) ? entry.names : [];
  if (names.includes(name)) return true;

  const dirs = Array.isArray(plugin.dirs) ? plugin.dirs : [];
  const targets = names.map(normalizePath).filter((n) => n !== '');
  if (targets.length === 0) return false;
  for (const dir of dirs) {
    const base = normalizePath(dir).toLowerCase();
    if (base === '') continue;
    for (const target of targets) {
      const p = target.toLowerCase();
      if (p === base || p.startsWith(`${base}/`)) return true;
    }
  }
  return false;
}

/**
 * 收集文件里所有已存在的 id（含 insert 子条目的 id）。
 * @param {string} text 整个 `cordis.patch.yml` 文本
 * @returns {Set<string>} id 集合（不含 null / 空串）
 */
export function existingIds(text) {
  /** @type {Set<string>} */
  const ids = new Set();
  for (const entry of splitTopLevel(text)) {
    if (entry.id) ids.add(entry.id);
    if (entry.kind === 'insert') {
      for (const child of splitInsertChildren(entry.raw)) {
        if (child.id) ids.add(child.id);
      }
    }
  }
  return ids;
}

/**
 * 给多行文本统一加缩进，空行（含纯空白行）不加。
 * @param {string} raw 多行文本
 * @param {number} spaces 缩进空格数
 * @returns {string} 加好缩进的文本
 * @throws {TypeError} 入参类型不对时抛出
 */
export function indentBlock(raw, spaces) {
  if (typeof raw !== 'string') {
    throw new TypeError('indentBlock 需要字符串输入');
  }
  const n = Number(spaces);
  if (!Number.isFinite(n) || n < 0) {
    throw new TypeError('indentBlock 的 spaces 必须是非负数字');
  }
  const pad = ' '.repeat(Math.floor(n));
  if (pad === '') return raw;
  return raw.replace(/^([ \t]*)(?=\S)/gm, (match) => pad + match);
}

/**
 * 判断字符串能否作为 YAML plain scalar 裸写。
 * @param {string} text 待判断的值
 * @returns {boolean}
 */
function isPlainSafe(text) {
  if (text.length === 0) return false;
  if (!PLAIN_RE.test(text)) return false;
  if (RESERVED_RE.test(text)) return false;
  if (NUMBER_RE.test(text)) return false;
  if (DATE_RE.test(text)) return false;
  return true;
}

/**
 * YAML 标量安全化：需要引号时用单引号包裹，内部单引号双写转义。
 * @param {unknown} value 任意值（null / undefined 视为空串）
 * @returns {string} 可直接写进 YAML 的标量
 */
export function yamlScalar(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (isPlainSafe(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * 按原文的引号风格格式化一个新值。
 * @param {string} originalText 冒号后的原值文本
 * @param {string} value 新值
 * @returns {string} 格式化后的标量
 */
function formatScalarLike(originalText, value) {
  const v = String(originalText ?? '').trim();
  if (v.startsWith("'")) return `'${value.replace(/'/g, "''")}'`;
  if (v.startsWith('"')) return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return yamlScalar(value);
}

/**
 * 从一条 row 原文里取 id；取不到返回 null。
 *
 * 只看前两个非空非注释行：
 *   - 首行是 `- id:`（缩进 0~4：顶层 row 与 insert 子条目两种形态）→ 取该值；
 *   - 否则次行是缩进 2 的 `id:`（row 首行是 `- name:` 之类时）→ 取该值；
 *   - insert 整块（首行 `- insert:`，次行是缩进 4 的子条目）→ null。
 * 更深缩进（config 列表项，如 llm models）不会命中。
 *
 * @param {string} raw row 原文（顶层 row 或 insert 子条目）
 * @returns {string|null} id 值（已去引号）
 */
export function rowId(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let seen = 0;
  for (const line of scanLines(raw)) {
    if (isBlank(line.content) || isComment(line.content)) continue;
    if (seen === 0) {
      const dashed = /^ {0,4}-[ \t]+id[ \t]*:(.*)$/.exec(line.content);
      if (dashed) return takeScalar(dashed[1]).value;
    } else if (seen === 1) {
      const own = /^ {2}id[ \t]*:(.*)$/.exec(line.content);
      if (own) return takeScalar(own[1]).value;
      return null;
    }
    seen += 1;
  }
  return null;
}

/**
 * 把一条 row 里的顶层 `name:` 值替换成 newName，保持引号风格。
 *
 * 顶层指列 0 的 `- name:` 或缩进 2 的 `name:`；更深层的 `name:` 不动。
 * 找不到时在 row 末尾补一行 `  name: ...`。
 *
 * @param {string} raw row 原文
 * @param {string} newName 新名字
 * @returns {string} 替换后的新文本
 * @throws {TypeError} 入参不是字符串时抛出
 */
export function replaceRowName(raw, newName) {
  if (typeof raw !== 'string') {
    throw new TypeError('replaceRowName 需要字符串输入');
  }
  if (raw.length === 0) {
    throw new Error('replaceRowName 收到空文本，无法定位 name');
  }
  const name = String(newName ?? '');

  const lines = scanLines(raw);
  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i].content;
    if (isComment(content)) continue;
    const m = /^([ \t]*(?:-[ \t]+)?name[ \t]*:)(.*)$/.exec(content);
    if (!m) continue;
    const prefix = /^[ \t]*/.exec(m[1])[0];
    const dashed = /^[ \t]*-[ \t]+/.test(m[1]);
    if (dashed && prefix.length !== 0) continue;
    if (!dashed && prefix.length !== 2) continue;

    const parsed = takeScalar(m[2]);
    const replacement = `${m[1]} ${formatScalarLike(m[2], name)}${parsed.rest}`;
    const at = lines[i].start;
    return raw.slice(0, at) + replacement + raw.slice(at + content.length);
  }

  const eol = detectEol(raw);
  const tail = raw.endsWith('\n') ? '' : eol;
  return `${raw}${tail}  name: ${yamlScalar(name)}`;
}

/**
 * 把一条 row 的 config 整段替换。
 *
 * `configBody` 是不含 `config:` 行的 YAML 片段，缩进由函数处理（相对 `config:` 再缩进 2）。
 * config 块的范围是 `config:` 行之后所有缩进更深的连续非空行。
 * 找不到 `config:` 行时在 row 末尾追加。
 *
 * @param {string} raw row 原文
 * @param {string} configBody 新的 config 内容（可为空串，空则写成 `config: {}`）
 * @returns {string} 替换后的新文本
 * @throws {TypeError} 入参不是字符串时抛出
 */
export function replaceRowConfig(raw, configBody) {
  if (typeof raw !== 'string') {
    throw new TypeError('replaceRowConfig 需要字符串输入');
  }
  const eol = detectEol(raw);
  const body = trimBlankLines(normalizeEol(String(configBody ?? ''), eol));
  const lines = scanLines(raw);

  for (let i = 0; i < lines.length; i += 1) {
    const content = lines[i].content;
    if (isComment(content)) continue;
    const m = /^([ \t]*)(-[ \t]+)?config[ \t]*:(.*)$/.exec(content);
    if (!m) continue;
    const indent = m[1].length;
    const dashed = Boolean(m[2]);
    if (dashed && indent !== 0) continue;
    if (!dashed && indent !== 2) continue;

    let last = i;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].content;
      if (isBlank(next)) break;
      if (indentOf(next) <= indent) break;
      last = j;
    }

    const pad = ' '.repeat(indent);
    const head =
      body === ''
        ? `${pad}config: {}`
        : `${pad}config:${eol}${indentBlock(body, indent + 2)}`;
    const trailingEol = lines[last].eol;
    const startOffset = lines[i].start;
    const endOffset = lines[last].end;
    return raw.slice(0, startOffset) + head + trailingEol + raw.slice(endOffset);
  }

  const tail = raw.endsWith('\n') ? '' : eol;
  if (body === '') return `${raw}${tail}  config: {}`;
  return `${raw}${tail}  config:${eol}${indentBlock(body, 4)}`;
}

/**
 * 把若干条 patch 行包成一个新的顶层 `- insert:` 块追加到 text 末尾。
 *
 * 输出结构：
 * ```
 * 原文（保证以单个换行结尾）
 * <空行，原文末尾没有空行时>
 * # >>> dsh-plugin-pack <comment>
 * - insert:
 *     <每条 row 的所有行，统一缩进 4 空格>
 * ```
 * 换行风格沿用原文（CRLF 输入产出全 CRLF）。rows 为空时不追加任何内容。
 *
 * @param {string} text 原文（可为空串）
 * @param {string[]} rows 每条是完整行原文，形如 `- id: foo` 开头的顶层行
 * @param {string} [comment] 注释里跟在 `# >>> dsh-plugin-pack` 后面的说明
 * @returns {{ text: string, added: number }} 新文本与追加的条目数
 * @throws {TypeError} 入参类型不对时抛出
 */
export function appendInsertBlock(text, rows, comment = '') {
  if (typeof text !== 'string') {
    throw new TypeError('appendInsertBlock 的 text 必须是字符串');
  }
  if (!Array.isArray(rows)) {
    throw new TypeError('appendInsertBlock 的 rows 必须是字符串数组');
  }
  for (const row of rows) {
    if (typeof row !== 'string') {
      throw new TypeError('appendInsertBlock 的 rows 每一项都必须是字符串');
    }
  }
  const list = rows.filter((row) => trimBlankLines(row) !== '');
  if (list.length === 0) return { text, added: 0 };

  const eol = detectEol(text);
  const label = String(comment ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  const head = label === '' ? '# >>> dsh-plugin-pack' : `# >>> dsh-plugin-pack ${label}`;

  let base = text;
  if (base.length > 0) {
    if (!base.endsWith('\n')) base += eol;
    if (!/(?:\r?\n)[ \t]*(?:\r?\n)$/.test(base)) base += eol;
  }

  const body = list
    .map((row) => indentBlock(normalizeEol(trimBlankLines(row), eol), 4))
    .join(eol);

  const block = `${head}${eol}- insert:${eol}${body}${eol}`;
  return { text: base + block, added: list.length };
}
