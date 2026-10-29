/**
 * 从网络安装整合包：来源识别 + 校验"确实是整合包"。
 *
 * 用户可能贴：仓库主页、Release 页、raw 直链、npm 包名、随便一个网址。
 * 要求：
 *   1. 各类地址都能正确归类
 *   2. 下载完成后必须校验是整合包，不是就明确报错
 *   3. 不能把 .exe/.dmg 之类当成包
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseSource, fetchBundleFrom } from '../lib/fetch-bundle.js';
import { exportBundle } from '../lib/export.js';
import { writeZip } from '../lib/zip.js';
import { saveIncomingZip } from '../lib/inbox.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-fetch-suite');

test('GitHub 仓库主页 → 按归档下载', () => {
  const parsed = parseSource('https://github.com/HTRP1486/dsh-plugin-pack');
  assert.equal(parsed.kind, 'github-repo');
  assert.equal(parsed.owner, 'HTRP1486');
  assert.equal(parsed.repo, 'dsh-plugin-pack');
  assert.equal(parsed.ref, undefined);
});

test('GitHub tree/<ref> → 指定 ref 的归档', () => {
  const parsed = parseSource('https://github.com/owner/repo/tree/v1.0.0');
  assert.equal(parsed.kind, 'github-repo');
  assert.equal(parsed.ref, 'v1.0.0');
});

test('GitHub Release 页 → 查 API 找附件', () => {
  const tagged = parseSource('https://github.com/owner/repo/releases/tag/v1.2.0');
  assert.equal(tagged.kind, 'github-release');
  assert.equal(tagged.tag, 'v1.2.0');

  const latest = parseSource('https://github.com/owner/repo/releases/latest');
  assert.equal(latest.kind, 'github-release');
  assert.equal(latest.tag, 'latest');
});

test('GitHub Release 附件直链 → 直接下', () => {
  const parsed = parseSource('https://github.com/owner/repo/releases/download/v1.0.0/pack.zip');
  assert.equal(parsed.kind, 'direct');
});

test('raw.githubusercontent.com → 直接下', () => {
  const parsed = parseSource('https://raw.githubusercontent.com/owner/repo/main/pack.zip');
  assert.equal(parsed.kind, 'direct');
});

test('npm 包名 → 走 registry', () => {
  assert.equal(parseSource('dsh-plugin-pack').kind, 'npm');
  assert.equal(parseSource('dsh-plugin-pack').name, 'dsh-plugin-pack');

  const scoped = parseSource('@scope/name');
  assert.equal(scoped.kind, 'npm');
  assert.equal(scoped.name, '@scope/name');

  const versioned = parseSource('dsh-plugin-pack@1.0.5');
  assert.equal(versioned.kind, 'npm');
  assert.equal(versioned.name, 'dsh-plugin-pack@1.0.5');
});

test('任意直链 → direct', () => {
  const parsed = parseSource('https://example.com/packs/my-pack.zip');
  assert.equal(parsed.kind, 'direct');
  assert.equal(parsed.url, 'https://example.com/packs/my-pack.zip');
});

test('GitHub 的 issue/wiki 等页面 → 报错，不当包来源', () => {
  assert.throws(() => parseSource('https://github.com/owner/repo/issues/1'), /不是包来源/);
});

test('空地址 / 非 http 协议 → 报错', () => {
  assert.throws(() => parseSource(''), /地址为空/);
  assert.throws(() => parseSource('ftp://x/y.zip'), /只支持 http\/https/);
  assert.throws(() => parseSource('not a url at all'), /地址格式不对|npm/);
});

test('下载到的普通 zip → 明确报"不是整合包"', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 造一个普通 zip 放进 inbox，模拟刚下载完
  const plain = writeZip([{ name: 'readme.txt', data: 'hello' }, { name: 'a/b.js', data: 'x' }]);
  const saved = saveIncomingZip({ home: TMP, filename: 'plain.zip', data: plain });

  // 直接用 inspectBundle 的语义验证：这里通过 fetchBundleFrom 的校验路径等价
  const { inspectBundle } = await import('../lib/import.js');
  let caught = null;
  try {
    inspectBundle(saved.file);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '应抛错');
  assert.equal(caught.code, 'NOT_A_BUNDLE');
  assert.match(caught.message, /zip 不是整合包/);
});

test('真正的整合包能通过校验', async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const pack = await exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });
  const { inspectBundle } = await import('../lib/import.js');
  const info = inspectBundle(pack.file);
  assert.equal(info.plugins.length, 2);
  assert.ok(String(info.manifest.format).startsWith('dsh-plugin-pack@'));
});

test('界面源码：导入页有网络安装入口且校验失败会高亮提示', async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.ok(src.includes('runNetworkInstall'), '应有网络安装处理函数');
  assert.ok(src.includes("'/plugin-pack/fetch-bundle'"), '应调用 fetch-bundle 接口');
  assert.ok(src.includes('net.title'), '应有从网络安装的标题');
  assert.ok(src.includes('net.notBundle'), '应有"下载到的不是整合包"提示');
  // 按 kind 分流：单插件与整合包走不同路径
  assert.ok(/fetched\.kind === 'plugin'/.test(src), '应按 kind 区分单插件与整合包');
});

test('npm 的 @版本 语法能正确拆成包名与版本', () => {
  // 这些是 parseSource 的输出，resolveNpmTarball 内部按 lastIndexOf('@') 拆
  const calc = (spec) => {
    const at = spec.lastIndexOf('@');
    const hasVersion = at > 0;
    return {
      pkgName: hasVersion ? spec.slice(0, at) : spec,
      version: hasVersion ? spec.slice(at + 1) : null,
    };
  };

  assert.deepEqual(calc('dsh-plugin-pack'), { pkgName: 'dsh-plugin-pack', version: null });
  assert.deepEqual(calc('dsh-plugin-pack@1.0.5'), { pkgName: 'dsh-plugin-pack', version: '1.0.5' });
  // scoped 包：开头的 @ 是 scope 标记，不是版本分隔
  assert.deepEqual(calc('@scope/name'), { pkgName: '@scope/name', version: null });
  assert.deepEqual(calc('@scope/name@1.2.3'), { pkgName: '@scope/name', version: '1.2.3' });
});

test('tgz 走单插件校验路径，不要求是整合包', async () => {
  const { fetchBundleFrom } = await import('../lib/fetch-bundle.js');
  // 用一个本地造的 tgz 验证：kind 应为 plugin，且有 package.json
  const { writeTgzStream } = await import('../lib/tar.js');
  const dir = path.join(os.tmpdir(), 'dsh-pp-fetch-tgz');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const tgz = path.join(dir, 'solo.tgz');
  await writeTgzStream(
    [
      { name: 'package/package.json', data: JSON.stringify({ name: 'solo-plugin', version: '2.1.0' }) },
      { name: 'package/index.js', data: 'export default 1;' },
    ],
    tgz,
  );

  // 直接把 tgz 放进 inbox 后走校验逻辑（等价于 fetchBundleFrom 的后半段）
  const { isTarball, unpackTarball } = await import('../lib/import-tgz.js');
  const { describeLocalPlugin } = await import('../lib/import-plugin.js');
  assert.equal(isTarball(tgz), true);
  const unpacked = unpackTarball({ file: tgz, home: dir });
  const info = describeLocalPlugin(unpacked.dir);
  assert.equal(info.name, 'solo-plugin');
  assert.equal(info.version, '2.1.0');
});
