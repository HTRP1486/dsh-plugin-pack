/**
 * 冲突识别要覆盖"非 local-plugins 安装"的插件。
 *
 * 老实现只看 `local-plugins/<segment>` 在不在。如果原插件是
 * npm / github / 绝对路径 link 装的（文件在 node_modules 里），
 * 它会被当成「新建」：
 *   - 重复装一份到 local-plugins
 *   - 把 dependencies 里的 `^0.4.1` / `github:...` 覆盖成 `link:`
 *   - 用户选「跳过」也不生效（只有 exists 的项才会看 decisions）
 *
 * 另外还要求：整合包里的版本比已装的更旧时，必须能被识别出来（覆盖=降级）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { importBundle, compareVersions } from '../lib/import.js';
import { exportBundle } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-conflict-detect');

/** 造 profile，可预置一个"以某种方式已安装"的插件。 */
function makeProfile(name, { preset = null } = {}) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'local-plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

  const dependencies = {};
  const bundles = [];

  if (preset) {
    // 模拟 npm 装的插件：文件在 node_modules，dependencies 写版本范围
    const pkgDir = path.join(dir, 'node_modules', preset.name);
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: preset.name, version: preset.installedVersion, main: 'index.js' }),
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export default 1;');
    dependencies[preset.name] = preset.spec;
    if (preset.inBundles !== false) bundles.push(preset.name);
  }

  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies, dsh: { profile: { bundles } } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# empty\n');
  return dir;
}

/** 导一个包含插件 X 的整合包（多插件 → zip）。 */
async function makeBundle(include) {
  return exportBundle({ include, out: `${TMP}\\`, maxBytes: 0 });
}

test('插件是 npm 装的（node_modules 里）→ 必须识别为已存在', async () => {
  const bundle = await makeBundle(['dsh-ops', 'dsh-plugin-pack']);
  const profile = makeProfile('npm-installed', {
    preset: { name: 'dsh-ops', installedVersion: '9.9.9', spec: '^9.9.9' },
  });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });
  const conflict = preview.conflicts.find((item) => item.name === 'dsh-ops');

  assert.ok(conflict, 'npm 装的插件必须被识别为冲突，而不是新建');
  assert.equal(conflict.installedVersion, '9.9.9');
  assert.equal(conflict.installSource, 'npm', '应标出来源是 npm');
  assert.equal(conflict.installedSpec, '^9.9.9');
});

test('选「跳过」时，npm 装的插件不被改动', async () => {
  const bundle = await makeBundle(['dsh-ops', 'dsh-plugin-pack']);
  const profile = makeProfile('skip-npm', {
    preset: { name: 'dsh-ops', installedVersion: '9.9.9', spec: '^9.9.9' },
  });

  const result = importBundle({
    file: bundle.file,
    profileDir: profile,
    decisions: { 'dsh-ops': 'skip' },
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['dsh-ops'], '^9.9.9', '跳过时不该把 ^9.9.9 覆盖成 link:');
  assert.equal(
    fs.existsSync(path.join(profile, 'local-plugins', 'dsh-ops')),
    false,
    '跳过时不该往 local-plugins 里塞一份',
  );

  const skipped = (result.plugins ?? []).find((item) => item.name === 'dsh-ops');
  assert.equal(skipped?.action, 'skipped', '结果里应记为 skipped');
});

test('选「覆盖」时，明确改成 link: 并记录改前值（可回滚）', async () => {
  const bundle = await makeBundle(['dsh-ops', 'dsh-plugin-pack']);
  const profile = makeProfile('overwrite-npm', {
    preset: { name: 'dsh-ops', installedVersion: '9.9.9', spec: '^9.9.9' },
  });

  const result = importBundle({
    file: bundle.file,
    profileDir: profile,
    decisions: { 'dsh-ops': 'overwrite' },
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(profile, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies['dsh-ops'], 'link:./local-plugins/dsh-ops', '覆盖后应是 link');

  // record 里要记下改前值，回滚才能还原成 ^9.9.9
  const record = JSON.parse(fs.readFileSync(path.join(result.backup, 'record.json'), 'utf8'));
  assert.equal(record.pkgDepsBefore['dsh-ops'].before, '^9.9.9');
  assert.equal(record.pkgDepsBefore['dsh-ops'].after, 'link:./local-plugins/dsh-ops');
});

test('整合包里的版本更旧 → 标记 older 并给出警告', async () => {
  const bundle = await makeBundle(['dsh-ops', 'dsh-plugin-pack']);
  const profile = makeProfile('older', {
    preset: { name: 'dsh-ops', installedVersion: '99.0.0', spec: '^99.0.0' },
  });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });
  const conflict = preview.conflicts.find((item) => item.name === 'dsh-ops');

  assert.equal(conflict.older, true, '包内版本更旧应被标出');
  assert.ok(
    preview.warnings.some((text) => /dsh-ops/.test(text) && /旧版本|降级/.test(text)),
    `应有一条降级警告，实际: ${JSON.stringify(preview.warnings)}`,
  );
});

test('包内版本更新 → 不标记 older', async () => {
  const bundle = await makeBundle(['dsh-ops', 'dsh-plugin-pack']);
  const profile = makeProfile('newer', {
    preset: { name: 'dsh-ops', installedVersion: '0.0.1', spec: '0.0.1' },
  });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });
  const conflict = preview.conflicts.find((item) => item.name === 'dsh-ops');
  assert.equal(conflict.older, false);
});

test('本地插件（local-plugins 里）仍然照常识别', async () => {
  const bundle = await makeBundle(['dsh-plugin-pack', 'dsh-one-click-polish']);
  const profile = makeProfile('local-installed');

  // 先装一次，让 local-plugins/dsh-plugin-pack 存在
  importBundle({ file: bundle.file, profileDir: profile });

  const preview = importBundle({ file: bundle.file, profileDir: profile, dryRun: true });
  const conflict = preview.conflicts.find((item) => item.name === 'dsh-plugin-pack');
  assert.ok(conflict, '本地安装的也要识别');
  assert.equal(conflict.installSource, 'local-plugins');
  assert.equal(conflict.sameVersion, true, '同版本应标出来');
});

test('compareVersions 基本正确', () => {
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0);
  assert.ok(compareVersions('1.1.9', '1.2.0') < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('v2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0, '正式版大于预发布');
  assert.ok(compareVersions('0.4.10', '0.4.9') > 0, '数字比较不是字符串比较');
});

test('界面源码：确认框会显示降级警告与安装来源', async () => {
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  assert.ok(src.includes('conflict.older'), '应显示「包内更旧·覆盖会降级」');
  assert.ok(src.includes('conflict.installedFrom'), '应显示已装来源');
  assert.ok(/compareVersions/.test(src), '客户端应有版本比较');
  assert.ok(/older: Boolean/.test(src), '预览行应计算 older');
});
