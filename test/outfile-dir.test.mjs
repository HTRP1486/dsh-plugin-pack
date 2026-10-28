/**
 * 导出目标目录选择的回归测试。
 *
 * 修的是两个具体毛病：
 *   1. 选目录时单击文件夹会直接钻进去 → 想把当前层某个文件夹当目标时永远点不到
 *   2. 选中目录后当成文件名，产出 D:\backup.zip 而不是 D:\backup\<默认名>.zip
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { resolveOutFile } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'outfile-test');

test('空字符串 → $DSH_HOME/exports/<默认名>', () => {
  const out = resolveOutFile('', 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.join('C:/home', 'exports', 'dsh-plugin-pack-desktop-20260101-000000.zip'));
});

test('已存在的目录 → 目录 + 默认文件名', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const out = resolveOutFile(TMP, 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.join(TMP, 'dsh-plugin-pack-desktop-20260101-000000.zip'));
  assert.ok(!out.endsWith('.zip.zip'));
});

test('末尾带分隔符但目录还不存在 → 仍当目录', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const notYet = path.join(TMP, 'newdir');
  const out = resolveOutFile(`${notYet}\\`, 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.join(notYet, 'dsh-plugin-pack-desktop-20260101-000000.zip'));
  // 关键：不能变成 newdir.zip
  assert.equal(out.includes('newdir.zip'), false);
});

test('末尾带正斜杠也认', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const notYet = path.join(TMP, 'slash');
  const out = resolveOutFile(`${notYet}/`, 'C:/home', 'p', 'ts');
  assert.equal(out, path.join(notYet, 'dsh-plugin-pack-p-ts.zip'));
});

test('明确给了 .zip 文件名 → 原样使用', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const file = path.join(TMP, '我的备份.zip');
  const out = resolveOutFile(file, 'C:/home', 'desktop', 'ts');
  assert.equal(out, file);
});

test('明确的文件名没有扩展名 → 补 .zip', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const file = path.join(TMP, 'backup-2026');
  const out = resolveOutFile(file, 'C:/home', 'desktop', 'ts');
  assert.equal(out, `${file}.zip`);
});

test('目录名里带点号也不受影响', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = path.join(TMP, 'v1.2.backup');
  fs.mkdirSync(dir, { recursive: true });
  const out = resolveOutFile(dir, 'C:/home', 'p', 'ts');
  assert.equal(out, path.join(dir, 'dsh-plugin-pack-p-ts.zip'), '目录名带点号时仍应识别为目录');
});

/* --------------------- 选择器交互（渲染层语义） --------------------- */

const clientFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

function makeReact() {
  const store = new Map();
  let cursor = 0;
  let key = 'x';
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
    },
    Fragment: Symbol('F'),
    useState(init) {
      const k = `${key}#${cursor++}`;
      if (!store.has(k)) store.set(k, typeof init === 'function' ? init() : init);
      return [store.get(k), (v) => store.set(k, typeof v === 'function' ? v(store.get(k)) : v)];
    },
    useEffect() {
      cursor += 1;
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useMemo(fn) {
      cursor += 1;
      return fn();
    },
    useRef(v) {
      cursor += 1;
      return { current: v };
    },
    __reset(k) {
      cursor = 0;
      key = k;
    },
    __store: store,
  };
}

async function loadClient(react) {
  let mod = null;
  globalThis.window = {
    __ModuleLoader__: { load({ factory }) { mod = factory((nm) => (nm === 'react' ? react : (() => { throw new Error(nm); })())); } },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.document = { createElement: () => ({ dataset: {} }), head: { append() {} } };
  await import(`${new URL(`file:///${clientFile.replace(/\\/g, '/')}`).href}?t=${Date.now()}`);
  return mod;
}

test('选择器在 dir 模式下：单击文件夹只选中，不进入', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { registered.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  // DirPicker 是内部组件，从设置页树里找它
  const section = registered.find((r) => r.spec.name === 'settings.section');
  assert.ok(section);

  // 直接验证源码里的关键分支存在（渲染层拿不到内部实例，这里做结构断言）
  const src = fs.readFileSync(clientFile, 'utf8');
  assert.ok(src.includes('pickingDir'), '应有 pickingDir 模式标记');
  assert.ok(src.includes('onDoubleClick'), '应有双击进入');
  assert.ok(src.includes("browse.pickHere"), '选目录时主按钮应是「用当前这个目录」');
  // 单击不再无条件 load
  assert.ok(
    /if \(item\.dir\) \{[\s\S]{0,220}setCursor\(index\)/.test(src),
    '单击文件夹应只选中光标',
  );
});

test('导出页选目录后补末尾分隔符，但选文件时不补', () => {
  const src = fs.readFileSync(clientFile, 'utf8');
  const at = src.indexOf('// 导出：只有选中的是「目录」才补末尾分隔符');
  assert.ok(at > 0, '应有导出分支注释');
  const snippet = src.slice(at, at + 700);
  assert.ok(snippet.includes('setOut'), '应设置输出路径');
  // 关键：要判断"像不像文件"，带扩展名的原样保留
  assert.ok(/looksLikeFile/.test(snippet), '应判断是否像文件');
  assert.ok(/\\\.\[a-z0-9\]/.test(snippet), '应检测扩展名');
  assert.ok(snippet.includes('endsWith'), '应判断末尾分隔符');
});

test('后端兜底：xxx.tgz\\ 这种误操作不再当目录拼一层', () => {
  // 用户选了文件后界面曾无条件补 `\`，导致 `a.tgz\` 被当目录，
  // 又在里面拼了个 zip。现在应识别出它是文件，原样返回。
  const out = resolveOutFile('D:/backup/a.tgz\\', 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.resolve('D:/backup/a.tgz'));
  assert.ok(!out.endsWith('.zip'), '不该在 a.tgz 后面再拼 zip');
});

test('后端兜底：真目录带分隔符仍按目录处理', () => {
  const out = resolveOutFile('D:/backup/\\', 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.join('D:/backup', 'dsh-plugin-pack-desktop-20260101-000000.zip'));
});

test('后端兜底：无扩展名的路径带分隔符 → 当目录', () => {
  const out = resolveOutFile('D:/mybackup\\', 'C:/home', 'desktop', '20260101-000000');
  assert.equal(out, path.join('D:/mybackup', 'dsh-plugin-pack-desktop-20260101-000000.zip'));
});
