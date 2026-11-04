/**
 * 链接整合包（layout: links）。
 *
 * manifest 里只有插件来源地址，不内嵌任何插件文件：
 *   普通整合包 → 几十~几百 MB，内容会过期
 *   链接整合包 → 几 KB，装的时候现取最新版
 *
 * 导入时逐个下载，再复用「单插件目录导入 / tgz 导入」落地。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { readLinkBundle, importLinkBundle } from '../lib/link-bundle.js';
import { writeZip } from '../lib/zip.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-link-bundle');

/** 造一个链接整合包。 */
function makeLinkBundle(name = 'links.zip', plugins = []) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name);
  fs.writeFileSync(
    file,
    writeZip([
      {
        name: 'manifest.json',
        data: JSON.stringify({ format: 'dsh-plugin-pack@2', layout: 'links', plugins }, null, 2),
      },
      { name: 'README.txt', data: '链接整合包' },
    ]),
  );
  return file;
}

test('能识别链接整合包并读出插件来源', () => {
  const file = makeLinkBundle('a.zip', [
    { name: 'dsh-plugin-pet', source: 'https://github.com/c-ling/dsh-plugin-pet' },
    { name: 'dsh-agentic-pet', source: 'dsh-agentic-pet' },
  ]);
  const parsed = readLinkBundle(file);
  assert.ok(parsed, '应识别为链接整合包');
  assert.equal(parsed.plugins.length, 2);
  assert.equal(parsed.plugins[0].source, 'https://github.com/c-ling/dsh-plugin-pet');
  assert.equal(parsed.plugins[1].source, 'dsh-agentic-pet');
});

test('普通整合包（layout: tarballs）不会被误认成链接整合包', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'normal.zip');
  fs.writeFileSync(
    file,
    writeZip([
      { name: 'manifest.json', data: JSON.stringify({ format: 'dsh-plugin-pack@2', layout: 'tarballs', plugins: [] }) },
    ]),
  );
  assert.equal(readLinkBundle(file), null);
});

test('没有 manifest 的 zip 不算链接整合包', () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'plain.zip');
  fs.writeFileSync(file, writeZip([{ name: 'a.txt', data: 'x' }]));
  assert.equal(readLinkBundle(file), null);
});

test('缺少 source 的条目会被过滤掉', () => {
  const file = makeLinkBundle('bad.zip', [
    { name: 'no-source' },
    { name: 'ok', source: 'dsh-plugin-pack' },
  ]);
  const parsed = readLinkBundle(file);
  assert.equal(parsed.plugins.length, 1);
  assert.equal(parsed.plugins[0].name, 'ok');
});

test('空 plugins → 导入时报 EMPTY_SELECTION', async () => {
  const file = makeLinkBundle('empty.zip', []);
  await assert.rejects(
    () => importLinkBundle({ file, profileDir: TMP, home: TMP, dryRun: true }),
    /没有可安装的插件/,
  );
});

test('dryRun 不下载、不写盘，只算冲突', async () => {
  // 造一个 profile，里面已装一个同名插件
  const profile = path.join(TMP, 'profile');
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(path.join(profile, 'local-plugins', 'dsh-agentic-pet'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'local-plugins', 'dsh-agentic-pet', 'package.json'),
    JSON.stringify({ name: 'dsh-agentic-pet', version: '0.4.9' }),
  );
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({
      name: 'p',
      private: true,
      dependencies: { 'dsh-agentic-pet': 'link:./local-plugins/dsh-agentic-pet' },
      dsh: { profile: { bundles: ['dsh-agentic-pet'] } },
    }),
  );

  const file = makeLinkBundle('conflict.zip', [
    { name: 'dsh-agentic-pet', source: 'dsh-agentic-pet' },
    { name: 'brand-new-plugin', source: 'brand-new-plugin' },
  ]);

  const before = fs.readFileSync(path.join(profile, 'package.json'), 'utf8');
  const preview = await importLinkBundle({ file, profileDir: profile, home: TMP, dryRun: true });

  assert.equal(preview.dryRun, true);
  assert.equal(preview.kind, 'link-bundle');
  assert.equal(preview.conflicts.length, 1, '只有已装的那个算冲突');
  assert.equal(preview.conflicts[0].name, 'dsh-agentic-pet');
  assert.equal(preview.conflicts[0].installedVersion, '0.4.9');
  assert.equal(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'), before, '不该改盘');
});

test('服务端源码：导入路由先认链接整合包', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'server.js'), 'utf8');
  assert.ok(src.includes('readLinkBundle'), '导入前应先检测链接整合包');
  assert.ok(src.includes('importLinkBundle'), '应走链接整合包导入');
  // 必须在 isTarball 分流之前判断，否则 .zip 会先被当普通整合包
  assert.ok(
    src.indexOf('readLinkBundle(body.file)') < src.indexOf('isTarball(body.file)'),
    '链接整合包的判断要在 tgz 分流之前',
  );
});
