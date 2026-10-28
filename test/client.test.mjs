/**
 * 客户端界面的冒烟测试。
 *
 * 宿主不向插件暴露真实的 react 包（它在客户端 bundle 内），
 * 所以这里用一个最小 React 桩：只实现 createElement / useState / useEffect /
 * useCallback / useMemo / useRef，再把人机界面渲染成 JSON 树做断言。
 *
 * 目的不是测样式，而是保证：
 *   1. client.js 能被 factory 正常执行（没有语法/引用错误）；
 *   2. 注册的 slot 名字与形态正确；
 *   3. 面板在 loading / 有数据 两种状态下都能渲染出预期结构；
 *   4. 关键按钮都在（导出、导入、回滚）。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientFile = path.join(here, '..', 'client.js');

/** 最小 React 桩：把 hooks 的返回值存进一个数组，渲染时按调用顺序取。 */
function makeReact() {
  const stateStore = new Map();
  let cursor = 0;
  let currentKey = 'root';

  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false) };
    },
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const key = `${currentKey}#${cursor}`;
      cursor += 1;
      if (!stateStore.has(key)) stateStore.set(key, typeof initial === 'function' ? initial() : initial);
      const set = (value) => {
        stateStore.set(key, typeof value === 'function' ? value(stateStore.get(key)) : value);
      };
      return [stateStore.get(key), set];
    },
    useEffect(effect) {
      cursor += 1;
      // 不真正执行副作用：只记录存在
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useMemo(fn) {
      cursor += 1;
      return fn();
    },
    useRef(value) {
      cursor += 1;
      return { current: value };
    },
    __reset(key) {
      cursor = 0;
      currentKey = key;
    },
    __setState(key, index, value) {
      stateStore.set(`${key}#${index}`, value);
    },
  };
  return react;
}

/** 加载 client.js，返回它导出的模块。 */
function loadClient(react) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        captured = factory((name) => {
          if (name === 'react') return react;
          throw new Error(`未预期的 require: ${name}`);
        });
        captured.__id = id;
      },
    },
  };
  // client.js 是 IIFE 形式，用 import 只为了执行副作用
  return import(`${new URL(`file:///${clientFile.replace(/\\/g, '/')}`).href}?t=${Date.now()}`).then(() => captured);
}

/** 把 createElement 树转成可断言的结构。 */
function toOutput(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(toOutput);
  if (typeof node.type === 'function') {
    // 递归渲染函数组件
    return toOutput(node.type({ ...node.props, children: node.children }));
  }
  return {
    type: typeof node.type === 'string' ? node.type : String(node.type),
    className: node.props?.className,
    text: node.children.length
      ? node.children
          .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : null))
          .filter(Boolean)
          .join('')
      : undefined,
    children: node.children.map(toOutput),
    props: node.props,
  };
}

/** 在整棵树里找所有文本。 */
function allText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) allText(item, out);
    return out;
  }
  if (typeof node === 'object') {
    if (node.text) out.push(node.text);
    if (node.children) allText(node.children, out);
  }
  return out;
}

/** 找所有 className 含指定串的节点。 */
function findByClass(node, needle, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const item of node) findByClass(item, needle, out);
    return out;
  }
  if (typeof node === 'object') {
    if (typeof node.className === 'string' && node.className.includes(needle)) out.push(node);
    if (node.children) findByClass(node.children, needle, out);
  }
  return out;
}

/** 找所有 type === 'button' 的节点。 */
function findButtons(node, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const item of node) findButtons(item, out);
    return out;
  }
  if (typeof node === 'object') {
    if (node.type === 'button') out.push(node);
    if (node.children) findButtons(node.children, out);
  }
  return out;
}

test('client.js 能被 factory 加载并导出 name/inject/apply', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  assert.ok(mod, 'factory 应返回模块');
  assert.equal(mod.__id, 'dsh-plugin-pack');
  assert.equal(mod.name, 'dsh-plugin-pack');
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  assert.equal(typeof mod.apply, 'function');
});

test('apply 注册 plugins.row.config 与 settings.section，不再常驻右下角', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  const effects = [];
  const ctx = {
    slots: {
      inject(name, fn) {
        fn();
      },
      register(spec, component) {
        registered.push({ spec, component });
        return () => {};
      },
    },
    locale: {
      register() {},
      bind: () => (key) => key,
    },
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      return dispose;
    },
  };
  mod.apply(ctx);

  const names = registered.map((item) => item.spec.name);
  // 插件页「已安装」列表里点开这一行，界面就在这里
  assert.ok(names.includes('plugins.row.config'), `应注册 plugins.row.config，实际 ${names.join(',')}`);
  assert.ok(names.includes('settings.section'), '应注册 settings.section');

  // 不再往会话界面塞常驻浮动按钮
  assert.equal(names.includes('shell.overlay'), false, '不应再注册 shell.overlay');
  assert.equal(names.filter((n) => n === 'shell.overlay').length, 0);

  const rowConfig = registered.find((item) => item.spec.name === 'plugins.row.config');
  assert.equal(rowConfig.spec.key, 'dsh-plugin-pack#dsh-plugin-pack');

  const section = registered.find((item) => item.spec.name === 'settings.section');
  assert.equal(section.spec.id, 'dsh-plugin-pack');
  assert.ok(typeof section.spec.label === 'function', 'label 应是函数');
  assert.ok(typeof section.component === 'function', '组件应是函数');

  assert.ok(effects.some((label) => String(label).includes('styles')), '应注入样式表');
});

test('plugins.row.config 的 summary 视图只输出一句提示', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: { inject: (n, f) => f(), register: (spec, c) => { registered.push({ spec, c }); return () => {}; } },
    locale: { register() {}, bind: () => (key) => (key === 'summary' ? '点开可一键导出/导入' : key) },
    effect: (f) => f(),
  });
  const rowConfig = registered.find((item) => item.spec.name === 'plugins.row.config');
  react.__reset('row');
  const tree = toOutput(rowConfig.c({ view: 'summary', t: (key) => (key === 'summary' ? '点开可一键导出/导入' : key) }));
  const text = allText(tree).join(' ');
  assert.ok(text.includes('点开可一键导出/导入'), `summary 应给出提示，实际: ${text}`);
  assert.equal(findButtons(tree).length, 0, 'summary 视图不应有按钮');
});

test('设置页在 loading 状态下渲染出标题与刷新按钮', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
    locale: { register() {}, bind: () => (key) => `T:${key}` },
    effect: (fn) => fn(),
  });

  const section = registered.find((item) => item.spec.name === 'settings.section');
  react.__reset('panel');
  const tree = toOutput(section.component({ t: (key) => `T:${key}` }));
  const text = allText(tree).join(' ');
  assert.ok(text.includes('T:title'), `应渲染标题，实际: ${text.slice(0, 200)}`);
  assert.ok(text.includes('T:tab.export'), '应有导出 tab');
  assert.ok(text.includes('T:tab.import'), '应有导入 tab');
  assert.ok(text.includes('T:tab.backup'), '应有备份 tab');
  assert.ok(text.includes('T:tab.help'), '应有帮助 tab');
  assert.ok(findButtons(tree).length > 0, '应有按钮');
});

test('插件行详情页（view: page）渲染完整面板', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
    locale: { register() {}, bind: () => (key) => `T:${key}` },
    effect: (fn) => fn(),
  });

  const rowConfig = registered.find((item) => item.spec.name === 'plugins.row.config');
  // 宿主 ui-plugin-manager 的真实调用形态：{ view: 'page', form }
  react.__reset('row-page');
  const tree = toOutput(rowConfig.component({ view: 'page', form: true, t: (key) => `T:${key}` }));
  const text = allText(tree).join(' ');

  assert.ok(text.includes('T:title'), `详情页应渲染标题，实际: ${text.slice(0, 160)}`);
  for (const tab of ['tab.export', 'tab.import', 'tab.backup', 'tab.help']) {
    assert.ok(text.includes(tab), `详情页缺少 ${tab}`);
  }
  assert.ok(findButtons(tree).length > 0, '详情页应有按钮');
});

test('summary 视图不渲染重面板（列表里只有一行简介）', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = [];
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
    locale: { register() {}, bind: () => (key) => `T:${key}` },
    effect: (fn) => fn(),
  });

  const rowConfig = registered.find((item) => item.spec.name === 'plugins.row.config');
  react.__reset('row-summary');
  const tree = toOutput(rowConfig.component({ view: 'summary', t: (key) => `T:${key}` }));
  const text = allText(tree).join(' ');
  assert.ok(text.includes('T:summary'), `summary 应只给一句简介，实际: ${text}`);
  // 列表里不该出现重面板特征
  assert.equal(text.includes('T:tab.export'), false, 'summary 不应渲染完整面板');
  assert.equal(findButtons(tree).length, 0, 'summary 不应有按钮');
});

test('界面文案覆盖所有关键动作（导出/导入/回滚/重启提示）', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  // 直接读 zh 字典：从 apply 的 locale.register 里抓
  let dict = null;
  mod.apply({
    slots: { inject: (name, fn) => fn(), register: () => () => {} },
    locale: {
      register: (ns, value) => {
        dict = value;
      },
      bind: () => (key) => key,
    },
    effect: (fn) => fn(),
  });
  assert.ok(dict?.zh, '应有 zh 字典');
  const required = [
    'export.run',
    'import.run',
    'import.inspect',
    'backup.rollback',
    'import.restart',
    'help.step1',
    'help.step4',
    'export.empty',
    'import.empty',
  ];
  for (const key of required) {
    assert.ok(dict.zh[key], `zh 缺少文案: ${key}`);
    assert.ok(dict.en[key], `en 缺少文案: ${key}`);
  }
  // 帮助页必须讲清四步，不含技术黑话
  assert.ok(/第一步/.test(dict.zh['help.step1']));
  assert.ok(/重启/.test(dict.zh['help.step4']));
});
