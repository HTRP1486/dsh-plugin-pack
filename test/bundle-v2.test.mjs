/**
 * 整合包 v2：zip 里每个插件是一个独立 .tgz。
 *
 * 这次改动的核心是包内布局：
 *   v1（旧）: packages/<段>/<散文件...>
 *   v2（新）: packages/<包名>-<版本>.tgz
 *
 * 断言：
 *   1. 导出后 zip 里只有 manifest + README + 每插件一个 tgz
 *   2. 抽出来的 tgz 与「单独导出单插件」得到的 tgz 结构一致
 *   3. 导入 v2 包能把文件正确解到 local-plugins
 *   4. v1 旧包仍能导入（向后兼容）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { exportBundle } from '../lib/export.js';
import { inspectBundle, importBundle } from '../lib/import.js';
import { readZipMeta, extractEntry, writeZip } from '../lib/zip.js';
import { readTgz } from '../lib/tar.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-v2-suite');

function readManifest(file) {
  const buffer = fs.readFileSync(file);
  const records = readZipMeta(buffer);
  const record = records.find((r) => r.name === 'manifest.json');
  assert.ok(record, '应有 manifest.json');
  return { manifest: JSON.parse(extractEntry(buffer, record).toString('utf8')), records, buffer };
}

test('v2 整合包的 zip 里只有 manifest + README + 每插件一个 tgz', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });

  assert.equal(result.kind, 'bundle');
  const { records, manifest } = readManifest(result.file);

  const names = records.map((r) => r.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('README.txt'));

  // packages/ 下只能是 .tgz，不能有散文件
  const packageEntries = names.filter((n) => n.startsWith('packages/'));
  assert.equal(packageEntries.length, 2, `应每个插件一个 tgz，实际 ${packageEntries.length}`);
  for (const entry of packageEntries) {
    assert.ok(/\.tgz$/.test(entry), `packages/ 下应是 tgz，实际 ${entry}`);
    assert.equal(entry.split('/').length, 2, `不应再有 packages/<段>/<文件> 这种层级：${entry}`);
  }

  assert.equal(manifest.format, 'dsh-plugin-pack@2');
  assert.equal(manifest.layout, 'tarballs');

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('整合包里的 tgz 与单独导出的 tgz 结构一致', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });

  // 单独导出单插件
  const single = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\single\\`, maxBytes: 0 });
  const singleItems = readTgz(fs.readFileSync(single.file));
  const singleNames = singleItems.map((i) => i.name).sort();

  // 从整合包里抽同一个插件的 tgz
  const bundle = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\bundle\\`, maxBytes: 0 });
  const { records, buffer, manifest } = readManifest(bundle.file);
  const declared = manifest.plugins.find((p) => p.name === 'dsh-plugin-pack').tgz;
  const tgzRecord = records.find((r) => r.name === declared);
  assert.ok(tgzRecord, `应能在 zip 里找到 ${declared}`);

  const innerItems = readTgz(extractEntry(buffer, tgzRecord));
  const innerNames = innerItems.map((i) => i.name).sort();

  assert.deepEqual(innerNames, singleNames, '整合包内的 tgz 应与单独导出的完全同构');

  // 内容也一致（对比 package.json）
  const singlePkg = singleItems.find((i) => i.name === 'package/package.json').data.toString();
  const innerPkg = innerItems.find((i) => i.name === 'package/package.json').data.toString();
  assert.deepEqual(JSON.parse(innerPkg), JSON.parse(singlePkg));

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('导入 v2 包：文件从 tgz 正确解到 local-plugins', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });

  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');

  const imported = importBundle({ file: result.file, profileDir: profile });
  assert.equal(imported.ok, true);
  assert.equal(imported.plugins.length, 2);

  for (const name of ['dsh-plugin-pack', 'dsh-one-click-polish']) {
    const dest = path.join(profile, 'local-plugins', name);
    assert.equal(fs.existsSync(path.join(dest, 'package.json')), true, `${name} 应有 package.json`);
    assert.equal(fs.existsSync(path.join(dest, 'client.js')), true, `${name} 应有 client.js`);
    // 关键：不该留下 package/ 这一层
    assert.equal(fs.existsSync(path.join(dest, 'package')), false, `${name} 不该有 package/ 中间层`);
  }

  // bundle 里两个插件都在
  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-plugin-pack'));
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-one-click-polish'));

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('v1 旧包仍能导入（向后兼容）', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 手工造 v1 散文件包
  const manifest = {
    format: 'dsh-plugin-pack@1',
    createdAt: new Date().toISOString(),
    source: { profile: 'old' },
    plugins: [{ name: 'legacy', version: '0.0.1', kind: 'package', patchRows: [], insertRows: [], deps: [], dataDirs: [] }],
    profile: { bundles: [], dependencies: {} },
    warnings: [],
  };
  const packFile = path.join(OUT, 'v1.zip');
  fs.writeFileSync(
    packFile,
    writeZip([
      { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
      {
        name: 'packages/legacy/package.json',
        data: JSON.stringify({ name: 'legacy', version: '0.0.1', type: 'module', main: 'lib/index.js' }, null, 2),
      },
      { name: 'packages/legacy/lib/index.js', data: 'export const x = 1;' },
    ]),
  );

  const info = inspectBundle(packFile);
  assert.equal(info.plugins.length, 1);
  assert.equal(info.plugins[0].files, 2, 'v1 应按散文件计数');

  const profile = path.join(OUT, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');

  const imported = importBundle({ file: packFile, profileDir: profile });
  assert.equal(imported.ok, true);
  assert.equal(fs.existsSync(path.join(profile, 'local-plugins', 'legacy', 'package.json')), true);
  assert.equal(fs.existsSync(path.join(profile, 'local-plugins', 'legacy', 'lib', 'index.js')), true);

  fs.rmSync(OUT, { recursive: true, force: true });
});

test('inspect 能报出每个插件的 tgz 路径', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });
  const info = inspectBundle(result.file);
  assert.equal(info.plugins.length, 2);
  for (const plugin of info.plugins) {
    assert.ok(plugin.tgz, `${plugin.name} 应报出 tgz`);
    assert.ok(plugin.tgz.endsWith('.tgz'));
    assert.equal(plugin.hasPackageJson, true);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
});
