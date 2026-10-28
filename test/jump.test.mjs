/**
 * 「跳转」按钮的行为测试。
 *
 * 用户反馈："这个跳转是干什么用的"——说明它不可自解释。
 * 现在的约定：
 *   - 有路径才可点，空路径点了要明说
 *   - 已经在这个目录时要明说，而不是静默无变化
 *   - 跳成功了给「已跳转」反馈
 *   - 粘一个 zip 路径 → 跳到它所在目录并选中它
 *   - 选文件时粘一个不存在的路径 → 报错，不偷偷建目录
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { browse } from '../lib/server.js';

const TMP = path.join(os.tmpdir(), 'jump-test');

test('路径不存在时默认报错，不在磁盘上造空目录', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const missing = path.join(TMP, 'nope');
  assert.throws(() => browse(missing), /路径不存在/);
  assert.equal(fs.existsSync(missing), false, '不该创建这个目录');
});

test('create: true 时才创建（导出目标目录需要）', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const target = path.join(TMP, 'make', 'me');
  const result = browse(target, { create: true });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(target), true);
});

test('粘一个 zip 的完整路径 → 跳到它所在目录并标记该文件', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = path.join(TMP, 'haszip');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'pkg.zip');
  fs.writeFileSync(zip, 'z');
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'x');

  const result = browse(zip);
  assert.equal(result.dir, path.resolve(dir), '应停在文件所在目录');
  assert.equal(result.selectFile, path.resolve(zip), '应把该 zip 标为选中');

  // 而且它确实在条目里，界面能据此定位光标
  const hit = result.items.find((item) => item.path === result.selectFile);
  assert.ok(hit, '选中的文件应在条目列表里');
  assert.equal(hit.dir, false);
});

test('大小写 / 末尾斜杠不影响识别', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = path.join(TMP, 'case');
  fs.mkdirSync(dir, { recursive: true });
  const a = browse(dir);
  const b = browse(`${dir}\\`);
  const c = browse(dir.toUpperCase());
  assert.equal(a.dir, b.dir, '末尾斜杠不应改变结果');
  if (process.platform === 'win32') assert.equal(a.dir, c.dir, 'Windows 大小写不敏感');
});

/* ------------------------ 界面层：跳转按钮不"像死的" ------------------------ */

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

test('输入框回车即确认；没有多余的「跳转」按钮', async () => {
  const src = fs.readFileSync(clientFile, 'utf8');

  // 按钮已删除：不该再有 browse.jump 这个 key 被渲染
  const jumpButtonUsage = /translate\('browse\.jump'\)/.test(src);
  assert.equal(jumpButtonUsage, false, '不应再渲染「跳转」按钮');

  // 回车必须仍然触发跳转
  assert.ok(/onKeyDown[\s\S]{0,200}event\.key === 'Enter'[\s\S]{0,120}doJump/.test(src), '回车应触发 doJump');

  // 反馈文案保留（成功/空/同目录都是"有话说"的关键）
  assert.ok(src.includes("'browse.jumpOk'"), '应有"已跳转"的成功反馈');
  assert.ok(src.includes("'browse.jumpEmpty'"), '应有"先填路径"的提示');
  assert.ok(src.includes("'browse.jumpSame'"), '应有"已经在这个目录"的提示');

  // 占位符要明说"按回车"
  assert.ok(/browse\.pathHint.*回车|回车.*browse\.pathHint/s.test(src) || src.includes('按回车'), '占位符应提示按回车');
});

test('跳转时按模式决定是否允许创建目录', async () => {
  const src = fs.readFileSync(clientFile, 'utf8');
  // load 与 doJump 都必须把 create 传成 mode === 'dir'
  const matches = src.match(/create:\s*mode === 'dir'/g) ?? [];
  assert.ok(matches.length >= 2, `load 与 doJump 都应传 create，实际 ${matches.length} 处`);
});

test('输入框失焦也自动确认，但只在值真被改过时', async () => {
  const src = fs.readFileSync(clientFile, 'utf8');

  // 必须有 onBlur 自动确认
  assert.ok(/onBlur[\s\S]{0,400}doJump/.test(src), '失焦应自动确认');

  // 必须有基线保护：否则点下面的文件夹会触发多余跳转
  assert.ok(src.includes('typedBaseline'), '应有输入框基线值，防止误触发');
  const blurBlock = src.slice(src.indexOf('onBlur:'), src.indexOf('onBlur:') + 520);
  assert.ok(blurBlock.includes('typedBaseline.current'), '失焦逻辑要比对基线值');
  assert.ok(/if \(text === typedBaseline\.current\) return/.test(blurBlock), '值没变就直接返回');

  // 占位符要让用户知道可以不按回车
  assert.ok(/browse\.pathHint/.test(src));
  const zhHint = /'browse\.pathHint': '([^']+)'/.exec(src)?.[1] ?? '';
  assert.ok(/回车/.test(zhHint) && /点到别处|失焦/.test(zhHint), `占位符应说明两种确认方式，实际: ${zhHint}`);
});

test('跳转成功会落到「已跳转」状态，而不是什么都不显示', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { registered.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  assert.ok(registered.length > 0, 'apply 应注册插槽');

  const src = fs.readFileSync(clientFile, 'utf8');
  // doJump 里成功路径要设 'ok'
  const at = src.indexOf('const doJump');
  assert.ok(at > 0, '应有 doJump');
  const body = src.slice(at, at + 1600);
  assert.ok(body.includes("setJumpState('ok')"), '成功时应有明确状态');
  assert.ok(body.includes('setJumpState({ error'), '失败时要显示错误');
});
