/**
 * 重名冲突的弹窗与逐插件决策。
 *
 * 场景：导入一个整合包，里面有的插件已经装过了。
 * 期望：dryRun 先报出 conflicts，界面弹窗，用户逐插件选覆盖/跳过，
 *       或者一键全部覆盖 / 全部跳过。
 *
 * 后端契约：
 *   dryRun  → { conflicts: [{ name, version, installedVersion, sameVersion, dest }] }
 *   正式导入 → 接受 decisions: { "<包名>": "overwrite" | "skip" }
 *            返回每个冲突插件的实际动作
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { exportBundle } from '../lib/export.js';
import { importBundle } from '../lib/import.js';
import { importTarball } from '../lib/import-tgz.js';
import { importLocalPlugin } from '../lib/import-plugin.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-conflict-suite');

/** 造一个空 profile。 */
function makeProfile(name = 'profile') {
  const profile = path.join(OUT, name);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(
    path.join(profile, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), '# p\n[]\n');
  return profile;
}

/** 造一个最小的本地插件目录。 */
function makePluginDir(name, version) {
  const dir = path.join(OUT, 'src', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version,
        type: 'module',
        main: 'lib/index.js',
        exports: { '.': './lib/index.js', './package.json': './package.json' },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), `export const v = ${JSON.stringify(version)};\n`);
  return dir;
}

/** 造一个多插件整合包（zip）。 */
async function makeBundle(name = 'pack') {
  return exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${OUT}\\${name}\\`,
    maxBytes: 0,
  });
}

test('dryRun 能报出与已装插件重名的冲突', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();
  const pack = await makeBundle();
  assert.ok(pack.file.endsWith('.zip'), '两个插件应导出 zip');

  // 先导一次
  const first = importBundle({ file: pack.file, profileDir: profile });
  assert.equal(first.ok, true);

  // 再 dryRun 同一个包 → 应报冲突
  const preview = importBundle({ file: pack.file, profileDir: profile, dryRun: true });
  assert.ok(Array.isArray(preview.conflicts), 'dryRun 应返回 conflicts');
  assert.equal(preview.conflicts.length, 2, `两个都已装过，应有 2 条冲突，实际 ${preview.conflicts.length}`);

  for (const conflict of preview.conflicts) {
    assert.ok(conflict.name);
    assert.ok(conflict.dest);
    assert.ok('installedVersion' in conflict, '应报出已装版本');
    assert.ok('sameVersion' in conflict, '应标记是否同版本');
    assert.equal(conflict.sameVersion, true, '重复导入同一个包，版本应相同');
  }
});

test('decisions 可以逐个插件选覆盖或跳过', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();
  const pack = await makeBundle();
  importBundle({ file: pack.file, profileDir: profile });

  // 一个跳过，一个覆盖
  const again = importBundle({
    file: pack.file,
    profileDir: profile,
    decisions: {
      'dsh-plugin-pack': 'skip',
      'dsh-one-click-polish': 'overwrite',
    },
  });
  assert.equal(again.ok, true);

  const a = again.plugins.find((p) => p.name === 'dsh-plugin-pack');
  const b = again.plugins.find((p) => p.name === 'dsh-one-click-polish');
  assert.equal(a.action, 'skipped', 'dsh-plugin-pack 应跳过');
  assert.equal(b.action, 'overwrite', 'dsh-one-click-polish 应覆盖');

  assert.equal(again.decisions['dsh-plugin-pack'], 'skip');
  assert.equal(again.decisions['dsh-one-click-polish'], 'overwrite');
});

test('全部覆盖 / 全部跳过 等价于给每个插件同样的 decisions', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();
  const pack = await makeBundle();
  importBundle({ file: pack.file, profileDir: profile });

  // 全部跳过
  const allSkip = importBundle({
    file: pack.file,
    profileDir: profile,
    decisions: { 'dsh-plugin-pack': 'skip', 'dsh-one-click-polish': 'skip' },
  });
  assert.ok(allSkip.plugins.every((p) => p.action === 'skipped'), '应全部跳过');

  // 全部覆盖
  const allOver = importBundle({
    file: pack.file,
    profileDir: profile,
    decisions: { 'dsh-plugin-pack': 'overwrite', 'dsh-one-click-polish': 'overwrite' },
  });
  assert.ok(allOver.plugins.every((p) => p.action === 'overwrite'), '应全部覆盖');
});

test('不给 decisions 时退回全局 mode', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();
  const pack = await makeBundle();
  importBundle({ file: pack.file, profileDir: profile });

  const skipped = importBundle({ file: pack.file, profileDir: profile, mode: 'skip' });
  assert.ok(skipped.plugins.every((p) => p.action === 'skipped'), 'mode=skip 应全跳过');

  const merged = importBundle({ file: pack.file, profileDir: profile, mode: 'merge' });
  assert.ok(merged.plugins.every((p) => p.action === 'overwrite'), 'mode=merge 应全覆盖');
});

test('本地插件导入也能报冲突并接受 decisions', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();

  const dir = makePluginDir('local-dup', '2.0.0');
  const first = importLocalPlugin({ dir, profileDir: profile });
  assert.equal(first.ok, true);
  assert.equal(first.plan.action, 'create', '首次应新建');

  const preview = importLocalPlugin({ dir, profileDir: profile, dryRun: true });
  assert.ok(Array.isArray(preview.conflicts));
  assert.equal(preview.conflicts.length, 1);
  assert.equal(preview.conflicts[0].name, 'local-dup');
  assert.equal(preview.conflicts[0].sameVersion, true);

  const skipped = importLocalPlugin({ dir, profileDir: profile, decisions: { 'local-dup': 'skip' } });
  assert.equal(skipped.skipped, true, 'skip 应生效');

  const over = importLocalPlugin({ dir, profileDir: profile, decisions: { 'local-dup': 'overwrite' } });
  assert.equal(over.ok, true);
  assert.equal(over.plan.action, 'overwrite');
});

test('全新安装时 conflicts 是空数组（界面不弹窗）', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();
  const pack = await makeBundle();
  const preview = importBundle({ file: pack.file, profileDir: profile, dryRun: true });
  assert.deepEqual(preview.conflicts, [], '全新安装不该有冲突');
});

test('tgz 单插件重复导入也有冲突与 decisions', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const profile = makeProfile();

  const single = await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\single\\`, maxBytes: 0 });
  assert.ok(single.file.endsWith('.tgz'));

  const first = importTarball({ file: single.file, home: OUT, profileDir: profile });
  assert.equal(first.ok, true);

  // 再导一次：dryRun 报冲突
  const preview = importTarball({ file: single.file, home: OUT, profileDir: profile, dryRun: true });
  assert.ok(Array.isArray(preview.conflicts), 'tgz 导入也应报冲突');
  assert.equal(preview.conflicts.length, 1);

  // 选跳过
  const skipped = importTarball({
    file: single.file,
    home: OUT,
    profileDir: profile,
    decisions: { 'dsh-plugin-pack': 'skip' },
  });
  assert.equal(skipped.skipped, true);
});
