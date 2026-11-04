/**
 * `dsh.bundle.patch` 是数组时不能崩。
 *
 * 实测 dsh-agentic-pet 用的是：
 *   "dsh": { "bundle": { "patch": ["./cordis.patch.yml", "./extra.yml"] } }
 * 早先代码只当字符串处理，path.join 收到数组直接抛
 * ERR_INVALID_ARG_TYPE: The "path" argument must be of type string。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { scanProfile, clearScanCache } from '../lib/scan.js';
import { describeLocalPlugin, importLocalPlugin } from '../lib/import-plugin.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-patch-array');

/** 造一个声明了多个 patch 文件的插件。 */
function makeProfileWithArrayPatch() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const profile = path.join(TMP, 'profile');
  const home = path.join(TMP, 'home');
  const pluginDir = path.join(profile, 'local-plugins', 'dsh-multi-patch');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  fs.writeFileSync(
    path.join(pluginDir, 'package.json'),
    JSON.stringify({
      name: 'dsh-multi-patch',
      version: '1.2.3',
      main: 'lib/index.js',
      dsh: {
        bundle: { patch: ['./cordis.patch.yml', './extra.patch.yml'] },
        client: { platform: 'web', immediately: true, inject: [] },
      },
    }),
  );
  fs.mkdirSync(path.join(pluginDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'lib', 'index.js'), 'export default {};');
  // 两份 patch 都必须用 name 指向本插件，否则按 id 匹配不上，测不到“是否读了第二个文件”
  fs.writeFileSync(
    path.join(pluginDir, 'cordis.patch.yml'),
    '- id: multi-a\n  name: dsh-multi-patch\n  config:\n    enabled: true\n',
  );
  fs.writeFileSync(
    path.join(pluginDir, 'extra.patch.yml'),
    '- id: multi-b\n  name: dsh-multi-patch\n  config:\n    extra: true\n',
  );

  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({
      name: 'p',
      private: true,
      dependencies: { 'dsh-multi-patch': 'link:./local-plugins/dsh-multi-patch' },
      dsh: { profile: { bundles: ['dsh-multi-patch'] } },
    }),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '- id: x\n');

  return { profile, home, pluginDir };
}

test('scan 遇到数组 patch 不抛错，且认出多份 patch', async () => {
  const { profile, home } = makeProfileWithArrayPatch();
  clearScanCache();

  const scan = await scanProfile({ profileDir: profile, dshHome: home });
  const plugin = scan.plugins.find((p) => p.name === 'dsh-multi-patch');
  assert.ok(plugin, '应扫描到插件');
  assert.equal(plugin.hasPatch, true, '有 patch 文件时应为 true');
  assert.equal(plugin.patchRel, './cordis.patch.yml', 'patchRel 取第一个');
  assert.deepEqual(plugin.patchRels, ['./cordis.patch.yml', './extra.patch.yml'], '应保留全部 patch 路径');
});

test('字符串形式的 patch 仍然正常', async () => {
  const { profile, home, pluginDir } = makeProfileWithArrayPatch();
  const pkgFile = path.join(pluginDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dsh.bundle.patch = './cordis.patch.yml';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));

  clearScanCache();
  const scan = await scanProfile({ profileDir: profile, dshHome: home });
  const plugin = scan.plugins.find((p) => p.name === 'dsh-multi-patch');
  assert.equal(plugin.hasPatch, true);
  assert.deepEqual(plugin.patchRels, ['./cordis.patch.yml']);
});

test('patch 指向不存在的文件 → hasPatch 为 false，不抛错', async () => {
  const { profile, home, pluginDir } = makeProfileWithArrayPatch();
  const pkgFile = path.join(pluginDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dsh.bundle.patch = ['./nope-a.yml', './nope-b.yml'];
  fs.writeFileSync(pkgFile, JSON.stringify(pkg));

  clearScanCache();
  const scan = await scanProfile({ profileDir: profile, dshHome: home });
  const plugin = scan.plugins.find((p) => p.name === 'dsh-multi-patch');
  assert.equal(plugin.hasPatch, false, '文件都不存在时不该谎报有 patch');
});

test('describeLocalPlugin 也能处理数组 patch', () => {
  const { pluginDir } = makeProfileWithArrayPatch();
  const info = describeLocalPlugin(pluginDir);
  assert.equal(info.name, 'dsh-multi-patch');
  assert.equal(info.hasPatch, true);
  assert.deepEqual(info.patchRels, ['./cordis.patch.yml', './extra.patch.yml']);
});

test('importLocalPlugin 会把多份 patch 的行都并进 profile', () => {
  const { profile, pluginDir } = makeProfileWithArrayPatch();

  /* 源目录必须独立于目标：importLocalPlugin 会先删掉
   * profile/local-plugins/<name> 再从源复制，源和目标同一个路径会把自己删了。 */
  const srcDir = path.join(TMP, 'source', 'dsh-multi-patch');
  fs.mkdirSync(path.dirname(srcDir), { recursive: true });
  fs.cpSync(pluginDir, srcDir, { recursive: true });
  fs.rmSync(pluginDir, { recursive: true, force: true });

  const result = importLocalPlugin({ dir: srcDir, profileDir: profile });
  assert.equal(result.ok, true);

  const patchText = fs.readFileSync(path.join(profile, 'cordis.patch.yml'), 'utf8');
  assert.match(patchText, /multi-a/, '第一份 patch 的行应并进来');
  assert.match(patchText, /multi-b/, '第二份 patch 的行也应并进来（早先只读第一个文件）');
});
