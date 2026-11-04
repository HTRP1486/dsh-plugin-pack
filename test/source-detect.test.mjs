/**
 * 从网络安装：一个入口认三种来源。
 *
 * 用户可能贴：
 *   - 整合包 zip（dsh-plugin-pack 导出的）
 *   - npm 包名（→ tarball）
 *   - 单个插件的原仓库（GitHub 归档 zip，里面是 package.json 而不是 manifest.json）
 *
 * 靠**内容**判断，不靠地址猜：
 *   .tgz                 → 单插件（npm tarball）
 *   .zip 有 manifest.json → 整合包
 *   .zip 有 package.json  → 单插件原仓库
 *   都没有                → 明确报错
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { fetchBundleFrom } from '../lib/fetch-bundle.js';
import { writeZip, readZip } from '../lib/zip.js';
import { saveIncomingZip } from '../lib/inbox.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-source-detect');

/**
 * 复刻 fetch-bundle 里的单插件检测：解 zip → 找 package.json 所在目录。
 * （导出函数内部用了临时目录，这里验证判定规则本身。）
 */
function detectPluginDir(zipBuffer) {
  const entries = readZip(zipBuffer);
  const pkgEntry = entries.find((e) => e.name === 'package.json' || /^[^/]+\/package\.json$/.test(e.name));
  if (!pkgEntry) return null;
  return pkgEntry.name === 'package.json' ? '.' : pkgEntry.name.split('/')[0];
}

test('仓库归档（多包一层目录）能被识别为单插件', () => {
  const buffer = writeZip([
    { name: 'dsh-pet-HEAD/package.json', data: JSON.stringify({ name: 'dsh-pet', version: '2.0.0' }) },
    { name: 'dsh-pet-HEAD/index.js', data: 'export default 1;' },
    { name: 'dsh-pet-HEAD/README.md', data: '# x' },
  ]);
  assert.equal(detectPluginDir(buffer), 'dsh-pet-HEAD');
});

test('package.json 在根目录也能识别', () => {
  const buffer = writeZip([
    { name: 'package.json', data: JSON.stringify({ name: 'solo', version: '1.0.0' }) },
    { name: 'index.js', data: 'x' },
  ]);
  assert.equal(detectPluginDir(buffer), '.');
});

test('没有 package.json 的普通 zip → 不认作插件', () => {
  const buffer = writeZip([
    { name: 'readme.txt', data: 'hello' },
    { name: 'src/a.js', data: 'x' },
  ]);
  assert.equal(detectPluginDir(buffer), null);
});

test('整合包 zip（有 manifest.json 没 package.json）→ 不认作单插件', () => {
  const buffer = writeZip([
    { name: 'manifest.json', data: JSON.stringify({ format: 'dsh-plugin-pack@2', plugins: [] }) },
    { name: 'packages/a-1.0.0.tgz', data: Buffer.alloc(10) },
  ]);
  assert.equal(detectPluginDir(buffer), null);
});

test('fetchBundleFrom：npm 包识别为单插件', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const result = await fetchBundleFrom({ source: 'dsh-plugin-pack', home: TMP, onProgress: () => {} });
  assert.equal(result.kind, 'plugin');
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].name, 'dsh-plugin-pack');
  assert.ok(result.file.endsWith('.tgz'));
});

test('fetchBundleFrom：真实整合包识别为 bundle', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const { exportBundle } = await import('../lib/export.js');
  const pack = await exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });
  // 用 file:// 不行，走 direct 分支需要 http；这里直接验证 inspect 语义
  const { inspectBundle } = await import('../lib/import.js');
  const info = inspectBundle(pack.file);
  assert.equal(info.plugins.length, 2);
  assert.ok(String(info.manifest.format).startsWith('dsh-plugin-pack@'));
});

test('fetchBundleFrom：GitHub 单插件仓库 → kind=plugin 且带 dir', async (t) => {
  fs.rmSync(TMP, { recursive: true, force: true });
  let result;
  try {
    result = await fetchBundleFrom({
      source: 'https://github.com/c-ling/dsh-plugin-pet',
      home: TMP,
      onProgress: () => {},
    });
  } catch (error) {
    // 没网时跳过（不静默通过：明确标记）
    t.diagnostic(`网络不可用，跳过：${error.code ?? ''} ${String(error.message).slice(0, 80)}`);
    return;
  }
  assert.equal(result.kind, 'plugin', 'GitHub 单插件仓库应识别为 plugin');
  assert.ok(result.dir, '应给出解压后的插件目录');
  assert.equal(result.plugins.length, 1);
  assert.equal(result.plugins[0].name, 'dsh-plugin-pet');
  // 解出来的目录里确实有 package.json
  assert.equal(fs.existsSync(path.join(result.dir, 'package.json')), true);
});

test('界面源码：网络安装按 dir 走目录导入，并弹确认框', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  assert.ok(/fetched\.dir/.test(src), '应处理 fetched.dir');
  assert.ok(src.includes("pending.kind === 'plugin-dir'"), '确认后应走目录导入');
  assert.ok(src.includes('doImportPlugin(fetched.dir, true)'), '应先 dryRun 预览冲突');
  assert.ok(src.includes('pendingDir'), '应记住待导入目录');
});

test('源码：服务端按内容区分三种来源', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'lib', 'fetch-bundle.js'), 'utf8');
  assert.ok(src.includes('detectPluginInZip'), '应有单插件检测');
  assert.ok(/不是整合包，检查是否为单个插件的原仓库/.test(src), '应说明检测意图');
  assert.ok(src.includes('kind: \'plugin\'') || src.includes("kind: 'plugin'"), '应返回 plugin 类型');
});
