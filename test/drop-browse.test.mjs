/**
 * 拖放导入 + 目录选择器的行为测试。
 *
 * 覆盖三块：
 *   1. multipart 解析（不带第三方库，必须自己对）
 *   2. 上传落盘：zip → inbox 文件；目录 → inbox 目录树，且防路径穿越
 *   3. browse 返回面包屑 / 盘符 / 文件，并支持"粘一个文件路径自动跳到它的目录"
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { parseMultipart, boundaryOf, saveIncomingZip, saveIncomingDir, pruneInbox } from '../lib/inbox.js';
import { browse, listRoots } from '../lib/server.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-inbox-test');

/** 造一个 multipart body。 */
function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n`;
    chunks.push(Buffer.from(disposition));
    chunks.push(Buffer.from('Content-Type: application/octet-stream\r\n\r\n'));
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(String(part.data)));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

/* ------------------------------ multipart ------------------------------ */

test('boundaryOf 解析各种 content-type', () => {
  assert.equal(boundaryOf('multipart/form-data; boundary=abc123'), 'abc123');
  assert.equal(boundaryOf('multipart/form-data; boundary="quoted"'), 'quoted');
  assert.equal(boundaryOf('application/json'), null);
  assert.equal(boundaryOf(''), null);
});

test('parseMultipart 正确切出文件与字段', () => {
  const boundary = 'X-BOUNDARY-X';
  const body = buildMultipart(boundary, [
    { name: 'f:a.txt', filename: 'a.txt', data: 'hello' },
    { name: 'f:b.bin', filename: 'b.bin', data: Buffer.from([0, 1, 2, 255]) },
  ]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'f:a.txt');
  assert.equal(parts[0].filename, 'a.txt');
  assert.equal(parts[0].data.toString(), 'hello');
  assert.equal(parts[1].filename, 'b.bin');
  assert.deepEqual([...parts[1].data], [0, 1, 2, 255]);
});

test('parseMultipart 处理二进制内容里的分隔符近似串', () => {
  const boundary = 'ZZ';
  // 内容里出现 "--Z" 但没构成分隔符
  const data = Buffer.concat([Buffer.from('--Z 不是分隔符 '), Buffer.from([0, 255]), Buffer.from(' 结尾')]);
  const body = buildMultipart(boundary, [{ name: 'f', filename: 'x.bin', data }]);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 1);
  assert.deepEqual([...parts[0].data], [...data]);
});

test('parseMultipart 对空 body 返回空数组', () => {
  assert.deepEqual(parseMultipart(Buffer.alloc(0), 'b'), []);
  assert.deepEqual(parseMultipart(Buffer.from('没有分隔符'), 'b'), []);
});

/* ------------------------------- 上传落盘 ------------------------------- */

test('saveIncomingZip 写入 inbox 并保留原名', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const home = path.join(TMP, 'home');
  const data = Buffer.from('PK fake zip content');
  const saved = saveIncomingZip({ home, filename: '我的整合包.zip', data });

  assert.equal(fs.existsSync(saved.file), true);
  assert.equal(saved.bytes, data.length);
  assert.ok(saved.file.includes('plugin-pack'), '应落在 plugin-pack/inbox 下');
  assert.ok(saved.file.endsWith('.zip'));
  assert.equal(fs.readFileSync(saved.file).toString(), data.toString());
});

test('saveIncomingZip 自动补 .zip 后缀并清洗非法字符', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const home = path.join(TMP, 'home');
  const saved = saveIncomingZip({ home, filename: 'a:b*c?.zip', data: Buffer.from('x') });
  assert.equal(fs.existsSync(saved.file), true);
  assert.equal(path.basename(saved.file).includes(':'), false, '应去掉冒号');
  assert.equal(path.basename(saved.file).includes('*'), false, '应去掉星号');

  const noExt = saveIncomingZip({ home, filename: 'bundle', data: Buffer.from('y') });
  assert.ok(noExt.file.endsWith('.zip'), '没有扩展名要补上');
});

test('saveIncomingZip 拒绝空内容', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.throws(() => saveIncomingZip({ home: path.join(TMP, 'h'), filename: 'x.zip', data: Buffer.alloc(0) }), /为空/);
});

test('saveIncomingDir 还原目录树', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const home = path.join(TMP, 'home');
  const saved = saveIncomingDir({
    home,
    rootName: 'my-plugin',
    files: [
      { rel: 'my-plugin/package.json', data: Buffer.from('{"name":"my-plugin"}') },
      { rel: 'my-plugin/lib/index.js', data: Buffer.from('export const x=1;') },
      { rel: 'my-plugin/client.js', data: Buffer.from('window.x=1;') },
    ],
  });

  assert.equal(saved.files, 3);
  assert.equal(fs.existsSync(path.join(saved.dir, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(saved.dir, 'lib', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(saved.dir, 'client.js')), true);
  assert.ok(saved.dir.endsWith('my-plugin'));
});

test('saveIncomingDir 挡住路径穿越', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const home = path.join(TMP, 'home');
  const saved = saveIncomingDir({
    home,
    rootName: 'evil',
    files: [
      { rel: '../../escape.txt', data: Buffer.from('bad') },
      { rel: 'ok.txt', data: Buffer.from('good') },
    ],
  });
  assert.equal(saved.files, 1, '穿越条目应被丢弃');
  assert.equal(fs.existsSync(path.join(saved.dir, 'ok.txt')), true);
  // 不能写到 inbox 之外
  const outside = path.resolve(saved.dir, '../../../escape.txt');
  assert.equal(fs.existsSync(outside), false, '不应写出 inbox');
});

test('saveIncomingDir 拒绝空文件列表', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  assert.throws(() => saveIncomingDir({ home: path.join(TMP, 'h'), rootName: 'x', files: [] }), /没有文件/);
});

test('pruneInbox 清掉过期目录、留住新的', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const home = path.join(TMP, 'home');
  const oldDir = path.join(home, 'plugin-pack', 'inbox', 'old');
  const newDir = path.join(home, 'plugin-pack', 'inbox', 'new');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  // 把 old 的 mtime 拨回 10 天前
  const past = (Date.now() - 10 * 86400000) / 1000;
  fs.utimesSync(oldDir, past, past);

  const removed = pruneInbox(home, 7);
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(oldDir), false, '旧目录应被清理');
  assert.equal(fs.existsSync(newDir), true, '新目录应保留');
});

/* ------------------------------ 目录浏览 ------------------------------- */

test('browse 返回面包屑、盘符与条目', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const deep = path.join(TMP, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'x.zip'), 'z');
  fs.writeFileSync(path.join(deep, 'y.txt'), 'not shown');
  fs.mkdirSync(path.join(deep, 'sub'));

  const result = browse(deep);
  assert.equal(result.ok, true);
  assert.equal(result.dir, path.resolve(deep));

  // 面包屑从根一路到当前
  assert.ok(Array.isArray(result.ancestors));
  assert.ok(result.ancestors.length >= 3, `面包屑应有多级，实际 ${result.ancestors.length}`);
  assert.equal(result.ancestors.at(-1).path, path.resolve(deep));
  assert.equal(result.ancestors[0].path, path.parse(path.resolve(deep)).root);

  // 盘符
  assert.ok(Array.isArray(result.roots));
  assert.ok(result.roots.length >= 1);
  assert.ok(result.roots.every((root) => root.path && root.name));

  // 只列子目录和 zip
  const names = result.items.map((item) => item.name);
  assert.ok(names.includes('sub'));
  assert.ok(names.includes('x.zip'));
  assert.equal(names.includes('y.txt'), false, '普通文件不应列出');
  // 目录排前面
  const firstFileIndex = result.items.findIndex((item) => !item.dir);
  if (firstFileIndex >= 0) {
    assert.ok(result.items.slice(firstFileIndex).every((item) => !item.dir));
  }
});

test('browse 粘一个文件路径会跳到它的目录并选中它', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = path.join(TMP, 'pick');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'target.zip');
  fs.writeFileSync(file, 'z');

  const result = browse(file);
  assert.equal(result.dir, path.resolve(dir), '应跳到文件所在目录');
  assert.equal(result.selectFile, path.resolve(file), '应把该文件标出来');
});

test('browse 对不存在的目录默认报错，不偷偷创建', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const target = path.join(TMP, 'created', 'deep');
  // 新语义：找 zip 时粘错路径，不该在磁盘上造空目录
  assert.throws(() => browse(target), /路径不存在/);
  assert.equal(fs.existsSync(target), false, '不该创建目录');

  // 显式 create 才创建（导出目标目录需要这个）
  const result = browse(target, { create: true });
  assert.equal(fs.existsSync(target), true);
  assert.equal(result.ok, true);
});

test('listRoots 在 Windows 上返回可用盘符', () => {
  const roots = listRoots();
  assert.ok(roots.length >= 1);
  if (process.platform === 'win32') {
    assert.ok(roots.some((root) => /^[A-Z]:\\$/.test(root.path)), `应至少有一个盘符，实际 ${JSON.stringify(roots)}`);
    assert.ok(roots.some((root) => root.path.toUpperCase() === 'C:\\'), '应有 C:\\');
  }
});

test('选目录模式不列文件：避免用户以为能选压缩包', () => {
  // 界面按 pickingDir 过滤掉了文件项；这里验证源码里的过滤逻辑存在，
  // 并确认 dir 模式下文件的「选它」按钮也被抑制。
  const clientFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js');
  const src = fs.readFileSync(clientFile, 'utf8');

  // 列表过滤：pickingDir 时只保留 item.dir
  assert.ok(
    /filter\(\(item\) => !pickingDir \|\| item\.dir\)/.test(src),
    '选目录模式应过滤掉文件',
  );
  // 文件行的选它按钮在 dir 模式下不渲染
  assert.ok(
    /: pickingDir\s*\?\s*null\s*:\s*h\(\s*'button'/.test(src),
    'dir 模式下不应给文件渲染「选它」按钮',
  );
  // 空目录提示按模式区分文案
  assert.ok(src.includes('空目录（这里没有子目录）'), 'dir 模式空目录提示不该提 zip');
});
