/**
 * 用真实 profile 数据把界面渲染一遍，确认四个标签页都能出内容。
 *
 * 这是「界面能不能给人看」的最后一道关卡：用真实 scan 结果喂给 Panel，
 * 断言每个页面都渲染出关键文案与行数。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { snapshot } from '../lib/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(here, '..', 'client.js');

function makeReact() {
  const store = new Map();
  let cursor = 0;
  let key = 'x';
  return {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
    },
    Fragment: Symbol('F'),
    useState(initial) {
      const k = `${key}#${cursor++}`;
      if (!store.has(k)) store.set(k, typeof initial === 'function' ? initial() : initial);
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
    __enter(k) {
      key = k;
      cursor = 0;
    },
    __leave() {},
    __store: store,
  };
}

async function load(react) {
  let mod = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        mod = factory((name) => {
          if (name === 'react') return react;
          throw new Error(`unexpected require ${name}`);
        });
      },
    },
  };
  await import(`${new URL(`file:///${clientFile.replace(/\\/g, '/')}`).href}?v=${Date.now()}`);
  return mod;
}

function walk(node, visit) {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  if (node.children) walk(node.children, visit);
}

/**
 * 渲染：逐层展开函数组件，每层用独立的 hook 缓存前缀（模拟 React 的组件实例）。
 *
 * 关键点：不同组件的 useState 不能共用 cursor，否则索引会串。
 * 这里给每个函数组件分配独立前缀，并把预置状态用路径前缀写进 store。
 */
function render(component, props, react, keyName) {
  const counter = { n: 0 };
  const expand = (node, prefix) => {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item, index) => expand(item, `${prefix}[${index}]`));
    if (typeof node.type === 'function') {
      const name = node.type.name || 'Anon';
      const childPrefix = `${prefix}>${name}${counter.n++}`;
      react.__enter(childPrefix);
      const rendered = node.type({ ...node.props, children: node.children });
      react.__leave();
      return expand(rendered, childPrefix);
    }
    return {
      type: typeof node.type === 'string' ? node.type : String(node.type),
      className: node.props?.className,
      props: node.props ?? {},
      children: (node.children ?? []).map((child, index) => expand(child, `${prefix}[${index}]`)),
    };
  };
  react.__enter(keyName);
  const tree = expand(component(props), keyName);
  react.__leave();
  return tree;
}

function texts(tree) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  };
  const visit = (node) => {
    if (node == null) return;
    if (typeof node === 'string' || typeof node === 'number') {
      push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node !== 'object') return;
    for (const child of node.children ?? []) visit(child);
    // 未展开的子组件，其 props.children 里也可能是文案
    const propsChildren = node.props?.children;
    if (propsChildren != null && node.type !== 'string') {
      if (Array.isArray(propsChildren)) {
        for (const item of propsChildren) visit(item);
      } else if (typeof propsChildren === 'object') {
        visit(propsChildren);
      }
    }
  };
  visit(tree);
  return out.join(' ');
}

/** 给某个渲染实例的 Panel 预置 useState 值。Panel 是第一个被展开的函数组件。 */
function seedPanel(react, keyName, values) {
  const prefix = `${keyName}>Panel0`;
  for (const [index, value] of Object.entries(values)) {
    react.__store.set(`${prefix}#${index}`, value);
  }
}

function buttons(tree) {
  const out = [];
  walk(tree, (node) => {
    if (node.type === 'button') out.push(node);
  });
  return out;
}

// snapshot 现在是异步的（扫描要遍历上万个文件，不能阻塞事件循环）
const status = await snapshot({});

test('真实数据下导出页列出全部插件', async () => {
  const react = makeReact();
  const mod = await load(react);
  const reg = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { reg.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  const section = reg.find((r) => r.spec.name === 'settings.section');
  // Panel 的 useState 顺序：0 tab, 1 status, 2 error, 3 busy, 4 selected, ...
  seedPanel(react, 'panel', {
    1: status,
    4: Object.fromEntries(status.plugins.map((p) => [p.name, true])),
  });
  const tree = render(section.c, { t: (k) => k }, react, 'panel');
  const text = texts(tree);

  assert.ok(text.includes('title'), '应有标题');
  const listRows = [];
  walk(tree, (node) => {
    if (typeof node.className === 'string' && node.className.includes('pp-row')) listRows.push(node);
  });
  assert.ok(listRows.length >= status.plugins.length, `插件行数应 ≥ ${status.plugins.length}，实际 ${listRows.length}`);

  // 每个插件名都应出现
  for (const plugin of status.plugins) {
    assert.ok(text.includes(plugin.name), `缺少插件名: ${plugin.name}`);
  }

  const labels = buttons(tree).map((b) => texts(b));
  assert.ok(labels.some((l) => l.includes('export.run')), '应有导出按钮');
});

test('导出页标签在渲染结构里齐全', async () => {
  const react = makeReact();
  const mod = await load(react);
  const reg = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { reg.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  seedPanel(react, 'p2', { 1: status });
  const section = reg.find((r) => r.spec.name === 'settings.section');
  const tree = render(section.c, { t: (k) => k }, react, 'p2');
  const text = texts(tree);
  for (const tab of ['tab.export', 'tab.import', 'tab.backup', 'tab.help']) {
    assert.ok(text.includes(tab), `缺少标签 ${tab}`);
  }
});

test('备份页在没有备份时给出空状态', async () => {
  const react = makeReact();
  const mod = await load(react);
  const reg = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { reg.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  seedPanel(react, 'p3', { 0: 'backup', 1: { ...status, backups: [], recentExports: [] } });
  const section = reg.find((r) => r.spec.name === 'settings.section');
  const tree = render(section.c, { t: (k) => k }, react, 'p3');
  assert.ok(texts(tree).includes('backup.none'), '无备份时应显示空状态');
});

test('帮助页四步说明完整', async () => {
  const react = makeReact();
  const mod = await load(react);
  const reg = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { reg.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (k) => k },
    effect: (f) => f(),
  });
  seedPanel(react, 'p4', { 0: 'help', 1: status });
  const section = reg.find((r) => r.spec.name === 'settings.section');
  const tree = render(section.c, { t: (k) => k }, react, 'p4');
  const text = texts(tree);
  for (const step of ['help.step1', 'help.step2', 'help.step3', 'help.step4']) {
    assert.ok(text.includes(step), `缺少 ${step}`);
  }
  assert.ok(text.includes('help.cmd'), '应提命令作为进阶选项');
});
