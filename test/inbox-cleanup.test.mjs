/**
 * 安装后清理下载副本。
 *
 * 规则：
 *   从 GitHub / npm 下载来的包 → 装完自动删掉 inbox 里那份副本（省磁盘）
 *   用户自己拖/选的本地文件     → 永远保留（那是他的东西，工具不该动）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { saveIncomingZip, inboxOrigin, removeInboxEntry } from '../lib/inbox.js';
import { writeZip } from '../lib/zip.js';

const HOME = path.join(os.tmpdir(), 'dsh-pp-inbox-origin');

function fresh() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  return writeZip([{ name: 'manifest.json', data: '{"format":"dsh-plugin-pack@2","plugins":[]}' }]);
}

test('默认来源是 upload（本地拖/选）', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'local.zip', data });
  assert.equal(inboxOrigin(saved.file), 'upload');
});

test('显式标 network 的记为 network', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'net.zip', data, origin: 'network' });
  assert.equal(inboxOrigin(saved.file), 'network');
});

test('没有标记文件的旧副本 → 返回 null（当成不删）', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'old.zip', data });
  // 手工删掉标记，模拟老版本落盘的文件
  fs.rmSync(path.join(path.dirname(saved.file), '.origin'));
  assert.equal(inboxOrigin(saved.file), null);
});

test('removeInboxEntry 能删掉网络副本所在的时间戳目录', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'net.zip', data, origin: 'network' });
  assert.equal(fs.existsSync(saved.file), true);

  assert.equal(removeInboxEntry(HOME, saved.file), true);
  assert.equal(fs.existsSync(path.dirname(saved.file)), false, '时间戳目录应被整体删除');
});

test('removeInboxEntry 拒绝删除 inbox 之外的文件', () => {
  const data = fresh();
  const outside = path.join(HOME, 'my-own-file.zip');
  fs.writeFileSync(outside, data);

  assert.equal(removeInboxEntry(HOME, outside), false, 'inbox 之外一律不删');
  assert.equal(fs.existsSync(outside), true, '外部文件必须还在');
});

test('removeInboxEntry 拒绝删除整个 inbox 根目录', () => {
  const data = fresh();
  saveIncomingZip({ home: HOME, filename: 'x.zip', data });
  const root = path.join(HOME, 'plugin-pack', 'inbox');
  assert.equal(removeInboxEntry(HOME, root), false, '不能把整个 inbox 删了');
  assert.equal(fs.existsSync(root), true);
});

test('removeInboxEntry 不删更深层的嵌套路径', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'x.zip', data });
  // 时间戳目录下的文件才允许；再往下一层就不是直接子目录了
  const nested = path.join(path.dirname(saved.file), 'sub', 'deep.zip');
  fs.mkdirSync(path.dirname(nested), { recursive: true });
  fs.writeFileSync(nested, data);
  assert.equal(removeInboxEntry(HOME, nested), false, '非时间戳直接子目录不处理');
  assert.equal(fs.existsSync(nested), true);
});

test('路径穿越写法删不掉外部文件', () => {
  const data = fresh();
  const saved = saveIncomingZip({ home: HOME, filename: 'x.zip', data });
  const evil = path.join(path.dirname(saved.file), '..', '..', '..', '..', 'important.zip');
  assert.equal(removeInboxEntry(HOME, evil), false);
});

test('removeInboxEntry 对不存在的路径返回 false，不抛错', () => {
  fresh();
  assert.equal(removeInboxEntry(HOME, path.join(HOME, 'plugin-pack', 'inbox', 'nope', 'a.zip')), false);
});

test('行为约定：network 装完删、upload 装完留', () => {
  const data = fresh();

  // 模拟从网络下载
  const net = saveIncomingZip({ home: HOME, filename: 'from-github.zip', data, origin: 'network' });
  // 模拟用户拖进来的
  const local = saveIncomingZip({ home: HOME, filename: 'from-desktop.zip', data, origin: 'upload' });

  // 服务端 autoCleanInbox 的判定逻辑：只有 network 才删
  const shouldClean = (file) => inboxOrigin(file) === 'network' && removeInboxEntry(HOME, file);

  assert.equal(shouldClean(net.file), true, '网络副本应被删');
  assert.equal(fs.existsSync(net.file), false);

  assert.equal(shouldClean(local.file), false, '本地文件不该被删');
  assert.equal(fs.existsSync(local.file), true, '本地文件必须还在');
});

test('界面源码：导入完成后不重复删（删除由服务端负责）', async () => {
  const fs2 = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverSrc = fs2.readFileSync(path.join(root, 'lib', 'server.js'), 'utf8');
  assert.ok(serverSrc.includes('autoCleanInbox'), '服务端应有自动清理逻辑');
  assert.ok(/inboxOrigin\(file\) !== 'network'/.test(serverSrc), '只清理 network 来源');
  assert.ok(serverSrc.includes('inboxCleaned'), '响应里应告知是否清理了');
});
