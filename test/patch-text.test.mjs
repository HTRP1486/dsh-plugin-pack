import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  splitTopLevel,
  splitInsertChildren,
  entryMatchesPlugin,
  existingIds,
  appendInsertBlock,
  indentBlock,
  yamlScalar,
  rowId,
  replaceRowName,
  replaceRowConfig,
} from '../lib/patch-text.js';

/** 样例 patch：内置 fixture，不依赖本机 profile（开源后别人也能跑）。 */
const REAL = new URL('./fixtures/cordis.patch.yml', import.meta.url);
/** 短样例：dsh-purge 风格的 patch。 */
const PURGE = new URL('./fixtures/purge-style.patch.yml', import.meta.url);

const realText = readFileSync(REAL, 'utf8');
const purgeText = readFileSync(PURGE, 'utf8');

/** 去掉行尾换行，用于比较「除结尾换行外逐字相同」。 */
const stripEol = (s) => s.replace(/\r?\n$/, '');

test('1. splitTopLevel / splitInsertChildren 能切真实 profile 文件', () => {
  const entries = splitTopLevel(realText);
  assert.ok(entries.length > 5, `顶层条目数应 > 5，实际 ${entries.length}`);
  // 条目数会随用户安装插件变化（每装一个插件就多一行），所以只校验下限与结构。
  assert.ok(entries.every((entry) => entry.kind === 'row' || entry.kind === 'insert' || entry.kind === 'other'));

  // 每个条目的 raw 必须能在原文里逐字找到，且偏移自洽
  for (const entry of entries) {
    assert.equal(realText.slice(entry.start, entry.end), entry.raw);
    assert.ok(realText.includes(entry.raw));
  }

  // 真实文件里 id 是 one-click-polish，name 才是 dsh-one-click-polish
  const polish = entries.find(
    (e) => e.id === 'dsh-one-click-polish' || e.names.includes('dsh-one-click-polish'),
  );
  assert.ok(polish, '应能找到 dsh-one-click-polish 条目');
  assert.equal(polish.kind, 'row');
  assert.equal(polish.id, 'one-click-polish');
  assert.ok(polish.names.includes('dsh-one-click-polish'));
  assert.equal(polish.disabled, false);
  assert.equal(rowId(polish.raw), 'one-click-polish');

  // 含 pwsh7-preference 的 insert 块
  const insert = entries.find((e) => e.kind === 'insert' && e.raw.includes('pwsh7-preference'));
  assert.ok(insert, '应能找到含 pwsh7-preference 的 insert 块');
  assert.equal(insert.id, null);
  assert.equal(rowId(insert.raw), null, 'insert 块没有自身 id');
  assert.deepEqual(insert.names, ['D:/Documents/dsh-pwsh7-preference/index.js']);

  const children = splitInsertChildren(insert.raw);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, 'pwsh7-preference');
  assert.deepEqual(children[0].names, ['D:/Documents/dsh-pwsh7-preference/index.js']);
  assert.equal(children[0].disabled, null);

  // insert 子条目里的多行 config 必须原样在 raw 里
  assert.ok(children[0].raw.includes('        blockWindowsPowerShell: true'));
  assert.ok(children[0].raw.includes("        allowMarker: '#ps5-ok'"));
});

test('2. entryMatchesPlugin 按 id / name / dirs 匹配', () => {
  // 真实 profile 文件里没有 dsh-purge 行，用 dsh-purge 包自己的 patch 测
  assert.equal(
    splitTopLevel(realText).some((e) => e.kind === 'row' && e.id === 'dsh-purge'),
    false,
    '真实 profile 文件里不应有 dsh-purge 行',
  );

  const purgeEntries = splitTopLevel(purgeText);
  const purgeRow = purgeEntries.find((e) => e.kind === 'row' && e.id === 'dsh-purge');
  assert.ok(purgeRow, 'dsh-purge patch 里应有 - id: dsh-purge 行');
  assert.equal(entryMatchesPlugin(purgeRow, { name: 'dsh-purge', dirs: [] }), true);

  // insert 块靠子条目的 name: 'dsh-purge' 命中
  const purgeInsert = purgeEntries.find((e) => e.kind === 'insert');
  assert.ok(purgeInsert);
  assert.equal(entryMatchesPlugin(purgeInsert, { name: 'dsh-purge', dirs: [] }), true);

  // 不相关条目不应命中
  const systemPrompt = purgeEntries.find((e) => e.id === 'system-prompt');
  assert.ok(systemPrompt);
  assert.equal(entryMatchesPlugin(systemPrompt, { name: 'dsh-purge', dirs: [] }), false);

  // dirs 分支：name 是目录下的入口文件路径
  const realInsert = splitTopLevel(realText).find((e) => e.kind === 'insert');
  assert.ok(realInsert);
  assert.equal(
    entryMatchesPlugin(realInsert, {
      name: 'dsh-pwsh7-preference',
      dirs: ['D:/Documents/dsh-pwsh7-preference'],
    }),
    true,
  );
  assert.equal(
    entryMatchesPlugin(realInsert, {
      name: 'dsh-pwsh7-preference',
      dirs: ['D:\\Documents\\dsh-pwsh7-preference\\'],
    }),
    true,
    '反斜杠 + 结尾分隔符也要能匹配',
  );
  assert.equal(
    entryMatchesPlugin(realInsert, { name: 'dsh-pwsh7-preference', dirs: ['D:/Documents/other'] }),
    false,
  );
  assert.equal(entryMatchesPlugin(realInsert, { name: '', dirs: [] }), false);
});

test('3. existingIds 覆盖所有 id 且不含 null', () => {
  const ids = existingIds(realText);
  assert.ok(ids instanceof Set, 'existingIds 应返回 Set');
  assert.ok(ids.size >= 10, `id 数应 >= 10，实际 ${ids.size}`);
  for (const id of ids) assert.equal(typeof id, 'string');

  for (const id of [
    'ui-settings-account',
    'ui-chat',
    'llm-pi-ai',
    'one-click-polish',
    'agent-preset-registry',
    'pwsh7-preference', // insert 子条目的 id
  ]) {
    assert.ok(ids.has(id), `应包含 id ${id}`);
  }
  assert.equal(ids.has(null), false);
  assert.equal(ids.has(''), false);

  // 与「顶层条目 id + insert 子条目 id」完全一致
  const expected = new Set();
  for (const entry of splitTopLevel(realText)) {
    if (entry.id) expected.add(entry.id);
    if (entry.kind === 'insert') {
      for (const child of splitInsertChildren(entry.raw)) if (child.id) expected.add(child.id);
    }
  }
  assert.deepEqual([...ids].sort(), [...expected].sort());
});

test('4. appendInsertBlock 追加 insert 块且不动原有条目', () => {
  const before = splitTopLevel(realText);
  const rows = [
    '- id: dsh-test-row\n  name: dsh-test-row\n  config:\n    enabled: true',
    '- id: dsh-test-row-2\n  name: dsh-test-row-2',
  ];
  const { text: out, added } = appendInsertBlock(realText, rows, 'test 追加');

  assert.equal(added, 2);
  assert.ok(out.includes('# >>> dsh-plugin-pack test 追加'));
  assert.ok(out.includes('- insert:\n    - id: dsh-test-row\n      name: dsh-test-row'));

  const after = splitTopLevel(out);
  assert.equal(after.length, before.length + 1, '只应多出一个顶层条目');

  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].id, before[i].id, `第 ${i} 条 id 不应变化`);
    assert.ok(out.includes(before[i].raw), `第 ${i} 条原文应逐字保留`);
    assert.equal(stripEol(after[i].raw), stripEol(before[i].raw));
  }

  const last = after[after.length - 1];
  assert.equal(last.kind, 'insert');
  assert.equal(last.id, null);
  const children = splitInsertChildren(last.raw);
  assert.deepEqual(
    children.map((c) => c.id),
    ['dsh-test-row', 'dsh-test-row-2'],
  );
  assert.deepEqual(children[0].names, ['dsh-test-row']);
  // 子条目字段缩进 6，config 内容缩进 8
  assert.ok(last.raw.includes('      config:\n        enabled: true'));
});

test('5. appendInsertBlock 边界：无结尾换行 / 空串 / 只有注释', () => {
  const rows = ['- id: dsh-edge\n  name: dsh-edge'];

  // 5a 原文末尾没有换行
  const noEol = '- id: a\n  name: a';
  const a = appendInsertBlock(noEol, rows, 'edge');
  const ea = splitTopLevel(a.text);
  assert.equal(ea.length, 2);
  assert.equal(ea[0].id, 'a');
  assert.equal(ea[0].kind, 'row');
  assert.equal(ea[1].kind, 'insert');
  assert.equal(splitInsertChildren(ea[1].raw)[0].id, 'dsh-edge');
  assert.ok(a.text.startsWith('- id: a\n  name: a\n\n# >>> dsh-plugin-pack edge\n- insert:\n'));

  // 5b 原文是空串
  const empty = appendInsertBlock('', rows, 'edge');
  assert.ok(empty.text.startsWith('# >>> dsh-plugin-pack edge\n- insert:\n    - id: dsh-edge\n'));
  const ee = splitTopLevel(empty.text);
  assert.equal(ee.length, 1);
  assert.equal(ee[0].kind, 'insert');
  assert.equal(ee[0].id, null);
  assert.equal(splitInsertChildren(ee[0].raw)[0].id, 'dsh-edge');
  assert.equal(empty.added, 1);

  // 5c 原文只有注释
  const commentsOnly = '# 只有注释\n# 第二行\n';
  const c = appendInsertBlock(commentsOnly, rows, 'edge');
  const ec = splitTopLevel(c.text);
  assert.equal(ec.length, 1);
  assert.equal(ec[0].kind, 'insert');
  assert.equal(splitInsertChildren(ec[0].raw)[0].id, 'dsh-edge');
  assert.ok(c.text.startsWith('# 只有注释\n# 第二行\n\n# >>> dsh-plugin-pack edge\n'));

  // 5d rows 为空时不追加任何东西
  const noRows = appendInsertBlock(noEol, [], 'edge');
  assert.equal(noRows.added, 0);
  assert.equal(noRows.text, noEol);
});

test('6. indentBlock 跳过空行；yamlScalar 按需加引号', () => {
  assert.equal(indentBlock('a\n\n  b\n', 2), '  a\n\n    b\n');
  assert.equal(indentBlock('a\r\n\r\nb\r\n', 4), '    a\r\n\r\n    b\r\n');
  assert.equal(indentBlock('', 4), '');
  assert.equal(indentBlock('   \nx\n', 2), '   \n  x\n', '纯空白行不加缩进');
  assert.equal(indentBlock('x', 0), 'x');

  assert.equal(yamlScalar('dsh-x'), 'dsh-x');
  assert.equal(yamlScalar('dsh-purge/redteam'), 'dsh-purge/redteam');
  assert.equal(yamlScalar('a: b'), "'a: b'");
  assert.equal(yamlScalar("'x'"), "'''x'''");
  assert.equal(yamlScalar('a#b'), "'a#b'");
  assert.equal(yamlScalar('x # y'), "'x # y'");
  assert.equal(yamlScalar("a'b"), "'a''b'");
  assert.equal(yamlScalar(''), "''");
  assert.equal(yamlScalar('true'), "'true'");
  // 真实文件里 welcomeNoticeVersion 就是裸写的 2026-08-13.1（不是 YAML 日期）
  assert.equal(yamlScalar('2026-08-13.1'), '2026-08-13.1');
  assert.equal(yamlScalar('2026-08-13'), "'2026-08-13'", '纯日期形要加引号，否则会被当 timestamp');
  assert.equal(yamlScalar('@deepseek-ai/dsh-x'), "'@deepseek-ai/dsh-x'");
  assert.equal(yamlScalar(null), "''");
});

test('7. replaceRowName / replaceRowConfig 在真实 row 上生效', () => {
  const entries = splitTopLevel(realText);
  const row = entries.find((e) => e.id === 'one-click-polish');
  assert.ok(row);
  const original = row.raw;

  // name 替换 + 引号风格保持（原来无引号，新值也无需引号）
  const renamed = replaceRowName(original, 'dsh-one-click-polish-v2');
  assert.ok(renamed.includes('  name: dsh-one-click-polish-v2'));
  const reEntries = splitTopLevel(renamed);
  assert.equal(reEntries.length, 1);
  assert.equal(reEntries[0].id, 'one-click-polish');
  assert.deepEqual(reEntries[0].names, ['dsh-one-click-polish-v2']);
  // 改回原名应逐字还原
  assert.equal(replaceRowName(renamed, 'dsh-one-click-polish'), original);

  // 需要引号的新名字要自动加引号
  const quoted = replaceRowName(original, 'a: b');
  assert.ok(quoted.includes("  name: 'a: b'"));
  assert.deepEqual(splitTopLevel(quoted)[0].names, ['a: b']);

  // config 整段替换：旧 config 消失，后面的 disabled 保留
  const configured = replaceRowConfig(renamed, 'modelSource: fixed\nprovider: codearts\nnested:\n  a: 1');
  assert.ok(configured.includes('  config:\n    modelSource: fixed\n    provider: codearts'));
  assert.ok(configured.includes('      a: 1'));
  assert.equal(configured.includes('autoResearch'), false, '旧 config 应被整段替换');
  assert.ok(configured.includes('  disabled: false'), 'config 后面的字段应保留');
  const cfgEntries = splitTopLevel(configured);
  assert.equal(cfgEntries.length, 1);
  assert.equal(cfgEntries[0].id, 'one-click-polish');
  assert.deepEqual(cfgEntries[0].names, ['dsh-one-click-polish-v2']);
  assert.equal(cfgEntries[0].disabled, false);

  // 没有 config: 的 row 走末尾追加
  const purgeRow = splitTopLevel(purgeText).find((e) => e.kind === 'row' && e.id === 'dsh-purge');
  assert.ok(purgeRow);
  const appended = replaceRowConfig(purgeRow.raw, 'enabled: true');
  assert.ok(appended.includes('  config:\n    enabled: true'));
  const appendedEntries = splitTopLevel(appended);
  assert.equal(appendedEntries.length, 1);
  assert.equal(appendedEntries[0].id, 'dsh-purge');
});

test('8. CRLF 输入经 appendInsertBlock 后仍全是 CRLF', () => {
  const crlf = '- id: a\r\n  name: a\r\n';
  const { text: out } = appendInsertBlock(crlf, ['- id: b\n  name: b'], 'crlf');

  assert.ok(out.includes('\r\n# >>> dsh-plugin-pack crlf\r\n- insert:\r\n'));
  assert.equal(/(^|[^\r])\n/.test(out), false, '不应出现裸 LF');
  assert.ok(out.endsWith('\r\n'));

  const entries = splitTopLevel(out);
  assert.equal(entries.length, 2);
  assert.ok(entries[0].raw.endsWith('\r\n'));
  assert.equal(splitInsertChildren(entries[1].raw)[0].id, 'b');
  assert.ok(entries[1].raw.includes('\r\n    - id: b\r\n'));
});

test('9. 空文件 / 纯注释文件返回空数组', () => {
  assert.deepEqual(splitTopLevel(''), []);
  assert.deepEqual(splitTopLevel('# 只有注释\n# 第二行\n'), []);
  assert.deepEqual(splitTopLevel('\n\n\n'), []);
  assert.deepEqual(splitInsertChildren(''), []);
  assert.deepEqual(splitInsertChildren('- insert:\n'), []);
});

test('10. 注释归属与结尾空行', () => {
  const entries = splitTopLevel(realText);
  // 文件头注释紧贴第一条，归入第一条 raw
  assert.ok(entries[0].raw.startsWith('# Your patch layer for this dsh profile'));
  assert.ok(entries[0].raw.startsWith('#'));
  // insert 块上方的两行注释也归入该 insert 块
  const insert = entries.find((e) => e.kind === 'insert');
  assert.ok(insert);
  assert.ok(insert.raw.startsWith('# PowerShell 7 优先'));
  // 条目 raw 不含结尾多余空行
  for (const entry of entries) {
    assert.equal(/\n[ \t]*\n$/.test(entry.raw), false, 'raw 不应以空行结尾');
    assert.equal(entry.raw, entry.raw.replace(/[ \t]+$/, ''));
  }

  // 空行隔开的文件头注释不属于任何条目
  const purgeEntries = splitTopLevel(purgeText);
  assert.ok(purgeEntries[0].raw.startsWith('# 关掉旧的独立红队包行'));
  assert.equal(purgeEntries[0].id, 'redteam-store');
  assert.equal(
    purgeEntries.some((e) => e.raw.includes('dsh-purge bundle patch')),
    false,
    '空行隔开的注释不应归入任何条目',
  );

  // 条目体内的注释保留在条目 raw 里
  const systemPrompt = purgeEntries.find((e) => e.id === 'system-prompt');
  assert.ok(systemPrompt.raw.includes('unknown prompt variable'));
  assert.ok(systemPrompt.raw.includes('    personaSuffix: ""'));

  // insert 子条目上方紧贴的注释归入该子条目
  const purgeInsert = purgeEntries.find((e) => e.kind === 'insert');
  const children = splitInsertChildren(purgeInsert.raw);
  assert.deepEqual(
    children.map((c) => c.id),
    ['dsh-purge', 'dsh-purge-redteam', 'dsh-purge-redteam-store', 'dsh-purge-redteam-ui'],
  );
  assert.ok(children[1].raw.startsWith('    # 演练台：预设 + 技能落地'));
  assert.ok(children[2].raw.includes("        root: !!js dshHomePath('redteam')"));
  assert.ok(children[0].raw.includes('    - id: dsh-purge\n      name: \'dsh-purge\''));
});

test('11. 插件包自己的 patch 也能解析', () => {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const entries = splitTopLevel(text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'insert');
  const children = splitInsertChildren(entries[0].raw);
  assert.equal(children.length, 1);
  assert.equal(children[0].id, 'dsh-plugin-pack');
  assert.deepEqual(children[0].names, ['dsh-plugin-pack']);
  // 子条目 config 里的注释和空字符串都在
  assert.ok(children[0].raw.includes("        exportDir: ''"));
  assert.ok(children[0].raw.includes('        # 空字符串 = $DSH_HOME/exports'));
});
