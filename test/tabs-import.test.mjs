/**
 * 插件页两个标签页（导入 / 导出）与本地插件导入的行为测试。
 *
 * 断言的核心事实：
 *   - 宿主 plugins.tab 插槽按 { id, label } 渲染标签，我们注册了 plugin-pack-import / plugin-pack-export
 *   - 标签内渲染的是对应单页（不重复出现子 tab 栏）
 *   - 本地插件导入会复制目录、写 dependencies/bundles、建链接，并且可回滚
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { importLocalPlugin, describeLocalPlugin } from '../lib/import-plugin.js';

const clientFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');

/* ------------------------------ 界面：标签页 ------------------------------ */

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
    __ModuleLoader__: {
      load({ id, factory }) {
        mod = factory((nm) => {
          if (nm === 'react') return react;
          throw new Error(`unexpected require ${nm}`);
        });
        mod.__id = id;
      },
    },
  };
  globalThis.document = { createElement: () => ({ dataset: {} }), head: { append() {} } };
  await import(`${new URL(`file:///${clientFile.replace(/\\/g, '/')}`).href}?t=${Date.now()}`);
  return mod;
}

function applyClient(mod) {
  const registered = [];
  mod.apply({
    slots: {
      inject: (name, fn) => fn(),
      register: (spec, component) => {
        registered.push({ spec, component });
        return () => {};
      },
    },
    locale: { register() {}, bind: () => (k) => k },
    effect: (fn) => fn(),
  });
  return registered;
}

function allText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) allText(item, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  for (const child of node.children ?? []) allText(child, out);
  const pc = node.props?.children;
  if (pc != null && typeof node.type !== 'string') {
    if (Array.isArray(pc)) for (const item of pc) allText(item, out);
    else if (typeof pc === 'object') allText(pc, out);
  }
  return out;
}

function expand(node, react, prefix) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item, i) => expand(item, react, `${prefix}[${i}]`));
  if (typeof node.type === 'function') {
    const name = `${prefix}>${node.type.name || 'A'}`;
    react.__reset(name);
    return expand(node.type({ ...node.props, children: node.children }), react, name);
  }
  return { type: node.type, props: node.props ?? {}, children: (node.children ?? []).map((c, i) => expand(c, react, `${prefix}.${i}`)) };
}

test('注册了「导入」「导出」两个 plugins.tab 标签页', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = applyClient(mod);

  const tabs = registered.filter((item) => item.spec.name === 'plugins.tab');
  assert.equal(tabs.length, 2, `应注册两个标签页，实际 ${tabs.length}`);

  const ids = tabs.map((item) => item.spec.id).sort();
  assert.deepEqual(ids, ['plugin-pack-export', 'plugin-pack-import']);

  for (const tab of tabs) {
    assert.ok(typeof tab.spec.label === 'function', 'label 应是函数（宿主 resolveSlotLabel 支持）');
    assert.ok(tab.spec.locale, '应带 locale 命名空间');
    assert.ok(typeof tab.component === 'function');
  }

  // 顺序：导入在前，导出在后
  const inOrder = tabs.map((item) => item.spec.id);
  assert.deepEqual(inOrder, ['plugin-pack-import', 'plugin-pack-export']);
});

test('两个标签页各自渲染对应单页，不嵌套子 tab 栏', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = applyClient(mod);

  for (const [id, expectKeys] of [
    ['plugin-pack-import', ['drop.title', 'drop.hint']],
    // 导出页不再有「整合包 / 单个插件」切换，改为按勾选数量自动决定
    ['plugin-pack-export', ['export.scope.none', 'export.title']],
  ]) {
    const tab = registered.find((item) => item.spec.id === id);
    react.__store.clear();
    const tree = expand(tab.component({ t: (k) => k }), react, id);
    const text = allText(tree).join(' ');

    for (const key of expectKeys) {
      assert.ok(text.includes(key), `${id} 应渲染 ${key}，实际: ${text.slice(0, 220)}`);
    }

    // onlyTab 模式下不渲染子 tab 栏：不应同时出现 backup/help 标签
    assert.equal(text.includes('tab.backup'), false, `${id} 不应出现子 tab 栏 (backup)`);
    assert.equal(text.includes('tab.help'), false, `${id} 不应出现子 tab 栏 (help)`);
  }
});

test('导入页有拖放区，且文案明确说了能拖 zip 和文件夹', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = applyClient(mod);

  const importTab = registered.find((item) => item.spec.id === 'plugin-pack-import');
  react.__store.clear();
  const tree = expand(importTab.component({ t: (k) => k }), react, 'drop');

  // 找带 pp-drop 类的节点
  let dropNode = null;
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.props?.className === 'string' && node.props.className.includes('pp-drop')) dropNode = node;
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.ok(dropNode, '导入页应有 pp-drop 拖放区');

  // 拖放区要挂上 drag/drop 处理器（不是纯装饰）
  assert.equal(typeof dropNode.props.onDrop, 'function', '应有 onDrop');
  assert.equal(typeof dropNode.props.onDragEnter, 'function', '应有 onDragEnter');
  assert.equal(typeof dropNode.props.onDragOver, 'function', '应有 onDragOver');
  assert.equal(typeof dropNode.props.onClick, 'function', '点击应能选文件');

  const text = allText(tree).join(' ');
  assert.ok(text.includes('drop.title'), '应有拖放标题文案');
  assert.ok(text.includes('drop.hint'), '应有拖放提示文案');
});

test('导入页：拖拽框 + 右上角「添加整合包」按钮，无旧页签', async () => {
  const react = makeReact();
  const mod = await loadClient(react);
  const registered = applyClient(mod);

  const importTab = registered.find((item) => item.spec.id === 'plugin-pack-import');
  react.__store.clear();
  const tree = expand(importTab.component({ t: (k) => k }), react, 'imp');
  const importText = allText(tree).join(' ');

  // 拖拽框仍在
  assert.ok(importText.includes('drop.title'), '导入页应有拖拽标题');
  assert.ok(importText.includes('drop.hint'), '导入页应有拖拽提示');

  // 右上角有「添加整合包」按钮（弹窗未打开时不渲染输入框）
  assert.ok(importText.includes('net.button'), '应有「添加整合包」按钮');
  assert.equal(importText.includes('net.dialogTitle'), false, '弹窗默认关闭，不该渲染');

  // 不该再有旧的支持页签/路径输入框/勾选项/开始导入按钮
  assert.equal(importText.includes('import.source.bundle'), false, '不该再有「整合包」页签');
  assert.equal(importText.includes('import.source.plugin'), false, '不该再有「本地插件」页签');
  assert.equal(importText.includes('import.pathHint'), false, '不该再有 zip 路径输入框');
  assert.equal(importText.includes('import.dry'), false, '不该再有「预演」勾选');
  assert.equal(importText.includes('import.restoreData'), false, '不该再有「还原数据」勾选');
  assert.equal(importText.includes('import.link'), false, '不该再有「建链接」勾选');
  assert.equal(importText.includes('import.run'), false, '不该再有「开始导入」按钮');

  // 弹窗关着时，页面上只该有拖拽框内部那一个隐藏 file input
  let inputs = 0;
  let textInputs = 0;
  const walk = (node) => {
    if (node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.type === 'input' || node.type === 'select') {
      inputs += 1;
      if (String(node.props?.type ?? '') === 'text') textInputs += 1;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  assert.equal(inputs, 1, `弹窗关闭时只该有隐藏 file input，实际 ${inputs}`);
  assert.equal(textInputs, 0, '弹窗关闭时不该有文本框');

  // 导出页：手动范围切换已删除，改为按勾选数量自动判断
  const exportTab = registered.find((item) => item.spec.id === 'plugin-pack-export');
  react.__store.clear();
  const exportText = allText(expand(exportTab.component({ t: (k) => k }), react, 'exp')).join(' ');
  assert.equal(exportText.includes('export.source.bundle'), false, '不该再有「整合包」切换');
  assert.equal(exportText.includes('export.source.plugin'), false, '不该再有「单个插件」切换');
  // 但要说明自动判断的规则
  assert.ok(exportText.includes('export.scope.none'), '应说明「勾 1 个单个、勾多个整合包」');
});

/* --------------------------- 本地插件导入行为 --------------------------- */

test('「添加整合包」弹窗：结构与自带「添加插件」对齐', async () => {
  const src = fs.readFileSync(clientFile, 'utf8');
  // 组件存在且以 open 控制
  assert.ok(src.includes('function AddBundleDialog'), '应有 AddBundleDialog 组件');
  assert.ok(/if \(!open\) return null/.test(src), '未打开时不该渲染');
  // 关键结构：标题、说明、输入框、示例折叠、提示块、整宽按钮
  assert.ok(src.includes('net.dialogTitle'), '应有弹窗标题');
  assert.ok(src.includes('net.desc'), '应有说明文字');
  assert.ok(src.includes('autoFocus: true'), '输入框应自动聚焦');
  assert.ok(src.includes('net.examples'), '应有可折叠的来源示例');
  assert.ok(src.includes('net.warnTitle'), '应有来源可信提示');
  assert.ok(src.includes('net.warnBody'), '提示应说明覆盖风险');
  assert.ok(src.includes("width: '100%'"), '安装按钮应整宽（对齐自带弹窗）');
  // Esc 关闭 + 点遮罩关闭，但跑的时候不关
  assert.ok(/event\.key === 'Escape'/.test(src), '应支持 Esc 关闭');
  assert.ok(/onClick: \(\) => !busy && onClose\(\)/.test(src), '点遮罩关闭，运行时不关');
  // 回车即安装
  assert.ok(/event\.key === 'Enter'/.test(src), '输入框回车应触发安装');
});

const FIXTURE = path.join(os.tmpdir(), 'local-plugin-fixture');
const FAKE_PROFILE = path.join(os.tmpdir(), 'local-plugin-profile');

function makePluginDir(options = {}) {
  const dir = path.join(FIXTURE, options.name ?? 'my-plugin');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const pkg = {
    name: options.name ?? 'my-plugin',
    version: '0.1.0',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './client.js', './package.json': './package.json' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['slots', 'locale'] },
    },
    dependencies: { 'left-pad': '^1.0.0', '@deepseek-ai/cordis': '^4' },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const name = "my-plugin";\n');
  fs.writeFileSync(path.join(dir, 'client.js'), 'window.__ModuleLoader__.load({id:"my-plugin",factory:()=>({})});\n');
  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    ['- insert:', '    - id: my-plugin', '      name: my-plugin', '      config:', '        enabled: true', ''].join('\n'),
  );
  // 不该被复制的东西
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(dir, 'node_modules', 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1;\n');
  return dir;
}

function makeProfile() {
  fs.rmSync(FAKE_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(FAKE_PROFILE, { recursive: true });
  fs.writeFileSync(
    path.join(FAKE_PROFILE, 'package.json'),
    JSON.stringify({ name: 'dsh-profile-test', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(FAKE_PROFILE, 'cordis.patch.yml'), '# test profile\n[]\n');
  return FAKE_PROFILE;
}

test('describeLocalPlugin 读出插件身份与依赖', () => {
  const dir = makePluginDir({ name: 'my-plugin' });
  const info = describeLocalPlugin(dir);
  assert.equal(info.name, 'my-plugin');
  assert.equal(info.version, '0.1.0');
  assert.equal(info.entry, 'lib/index.js');
  assert.equal(info.hasPatch, true);
  assert.deepEqual(info.deps, ['left-pad'], '应排除 @deepseek-ai/*');
});

test('describeLocalPlugin 拒绝没有 package.json 的目录', () => {
  const dir = path.join(FIXTURE, 'empty-dir');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => describeLocalPlugin(dir), /package.json/);
});

test('本地导入插件：复制、写配置、建链接', () => {
  const dir = makePluginDir({ name: 'my-plugin' });
  const profile = makeProfile();

  const result = importLocalPlugin({ dir, profileDir: profile });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, 'my-plugin');
  assert.equal(result.restartRequired, true);

  // 1) 本体已复制，且跳过 .git / node_modules
  const dest = path.join(profile, 'local-plugins', 'my-plugin');
  assert.equal(fs.existsSync(path.join(dest, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(dest, 'client.js')), true);
  assert.equal(fs.existsSync(path.join(dest, 'lib', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(dest, '.git')), false, '不应复制 .git');
  assert.equal(fs.existsSync(path.join(dest, 'node_modules')), false, '不应复制 node_modules');

  // 2) profile/package.json：dependencies + bundles
  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['my-plugin'], 'link:./local-plugins/my-plugin');
  assert.ok(pkg.dsh.profile.bundles.includes('my-plugin'));

  // 3) patch 行已合并
  const patch = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('my-plugin'), 'patch 应包含这个插件');
  assert.ok(patch.includes('- insert:'), '应先包成 insert 块');

  // 4) node_modules 链接
  const link = path.join(profile, 'node_modules', 'my-plugin');
  assert.equal(fs.existsSync(link), true, '应建立 node_modules 链接');
  const real = fs.realpathSync(link);
  assert.equal(real.toLowerCase().endsWith('local-plugins\\my-plugin') || real.toLowerCase().endsWith('local-plugins/my-plugin'), true);

  // 5) 备份可回滚
  assert.ok(fs.existsSync(result.backup), '应有备份目录');
  assert.ok(fs.existsSync(path.join(result.backup, 'record.json')));
  assert.ok(fs.existsSync(path.join(result.backup, 'package.json')));
});

test('本地导入会备份并覆盖已存在的同名插件目录', () => {
  const dir = makePluginDir({ name: 'dup-plugin' });
  const profile = makeProfile();

  importLocalPlugin({ dir, profileDir: profile });
  const dest = path.join(profile, 'local-plugins', 'dup-plugin');
  fs.writeFileSync(path.join(dest, 'marker.txt'), 'old');

  const second = importLocalPlugin({ dir, profileDir: profile });
  assert.equal(second.ok, true);
  assert.equal(second.plan.action, 'overwrite');
  // 老内容被替换：marker 不在新副本里
  assert.equal(fs.existsSync(path.join(dest, 'marker.txt')), false);
  // 但旧副本进了备份
  const backups = fs.readdirSync(path.join(profile, '.plugin-backups'));
  assert.ok(backups.length >= 2, '应有多次备份');
});

test('mode=skip 时不覆盖已有插件', () => {
  const dir = makePluginDir({ name: 'skip-plugin' });
  const profile = makeProfile();
  importLocalPlugin({ dir, profileDir: profile });
  const dest = path.join(profile, 'local-plugins', 'skip-plugin');
  fs.writeFileSync(path.join(dest, 'marker.txt'), 'keep-me');

  const result = importLocalPlugin({ dir, profileDir: profile, mode: 'skip' });
  assert.equal(result.skipped, true);
  assert.equal(fs.existsSync(path.join(dest, 'marker.txt')), true, 'skip 模式下不应动已有内容');
});

test('dryRun 不写任何文件', () => {
  const dir = makePluginDir({ name: 'dry-plugin' });
  const profile = makeProfile();
  const result = importLocalPlugin({ dir, profileDir: profile, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.plan.name, 'dry-plugin');
  assert.equal(fs.existsSync(path.join(profile, 'local-plugins', 'dry-plugin')), false, 'dryRun 不应复制');
  assert.equal(fs.existsSync(path.join(profile, '.plugin-backups')), false, 'dryRun 不应建备份');

  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {}, 'dryRun 不应改 dependencies');
});
