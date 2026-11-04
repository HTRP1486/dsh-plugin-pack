/**
 * 回滚不能把用户后加的配置一起抹掉。
 *
 * 事故复现：导入插件 → 用户又去设置了 API 密钥 → 点回滚 →
 * 早先的实现整份覆盖 cordis.patch.yml/package.json，
 * 把快照之后的改动全删了，密钥也没了。
 *
 * 现在的要求：
 *   1. 回滚只撤销"这次导入加的东西"
 *   2. 同一个文件里用户后加的行必须留着
 *   3. 回滚前先把当前配置另存一份，任何时候都能反悔
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { importBundle, rollbackImport } from '../lib/import.js';
import { exportBundle } from '../lib/export.js';

const TMP = path.join(os.tmpdir(), 'dsh-pp-rollback-safe');

/** 造一个空 profile。 */
function makeProfile(name) {
  const dir = path.join(TMP, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'local-plugins'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'p', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), '# 我的配置\n- id: my-llm\n  config:\n    apiKey: sk-KEEP-ME\n');
  return dir;
}

/** 导出一个包含两个插件的整合包（单插件会导出成 tgz）。 */
async function makeBundle() {
  return exportBundle({
    include: ['dsh-plugin-pack', 'dsh-one-click-polish'],
    out: `${TMP}\\`,
    maxBytes: 0,
  });
}

test('回滚后：用户后加的 API 密钥还在', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('keep-keys');

  const imported = importBundle({ file: bundle.file, profileDir: profile });
  assert.equal(imported.ok, true);

  // 导入之后用户又加了一段配置（模拟设 API 密钥）
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const afterImport = fs.readFileSync(patchFile, 'utf8');
  fs.writeFileSync(
    patchFile,
    `${afterImport}\n# 导入之后我自己加的\n- id: my-new-provider\n  config:\n    baseURL: https://opencode.ai/zen/go/v1\n    apiKey: sk-NEW-KEY\n`,
  );

  const rolled = rollbackImport({ profileDir: profile, backup: imported.backup });
  const finalText = fs.readFileSync(patchFile, 'utf8');

  assert.match(finalText, /sk-KEEP-ME/, '原有的密钥必须还在');
  assert.match(finalText, /sk-NEW-KEY/, '导入之后加的密钥也必须还在');
  assert.match(finalText, /my-new-provider/, '导入之后加的 provider 块必须还在');
  assert.equal(rolled.mode, 'surgical', '应走精准回滚');
});

test('回滚后：导入追加的那些 patch 行被移除', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('remove-added');

  const imported = importBundle({ file: bundle.file, profileDir: profile });
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const withImport = fs.readFileSync(patchFile, 'utf8');
  assert.ok(withImport.length > 0);

  rollbackImport({ profileDir: profile, backup: imported.backup });
  const after = fs.readFileSync(patchFile, 'utf8');

  // 用户原本的那行要在
  assert.match(after, /my-llm/);
  // 导入时追加的（带 plugin-pack 标记的块）要没了
  assert.equal(/plugin-pack \d{8}-\d{6}/.test(after), false, '导入追加的块应被摘掉');
  assert.ok(after.length < withImport.length, '文件应变短');
});

test('回滚后：依赖与 bundles 只撤销本次导入的', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('pkg-scope');

  // 预置一个用户自己的依赖 + bundle
  // （目录必须真实存在，否则回滚后的自动对账会把它当成僵尸条目清掉）
  const ownDir = path.join(profile, 'local-plugins', 'my-own-plugin');
  fs.mkdirSync(ownDir, { recursive: true });
  fs.writeFileSync(path.join(ownDir, 'package.json'), JSON.stringify({ name: 'my-own-plugin', version: '1.0.0' }));
  const pkgFile = path.join(profile, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dependencies['my-own-plugin'] = 'link:./local-plugins/my-own-plugin';
  pkg.dsh.profile.bundles.push('my-own-plugin');
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

  const imported = importBundle({ file: bundle.file, profileDir: profile });

  const rolled = rollbackImport({ profileDir: profile, backup: imported.backup });
  const after = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));

  assert.equal(
    after.dependencies['my-own-plugin'],
    'link:./local-plugins/my-own-plugin',
    '用户自己的依赖必须保留',
  );
  assert.ok(after.dsh.profile.bundles.includes('my-own-plugin'), '用户自己的 bundle 必须保留');
  assert.equal(after.dependencies['dsh-plugin-pack'], undefined, '导入的依赖应被撤销');
  assert.equal(after.dsh.profile.bundles.includes('dsh-plugin-pack'), false, '导入的 bundle 应被撤销');
  assert.equal(rolled.mode, 'surgical');
});

test('回滚前会另存当前配置（pre-rollback 快照）', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('pre-snapshot');

  const imported = importBundle({ file: bundle.file, profileDir: profile });
  const patchFile = path.join(profile, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, `${fs.readFileSync(patchFile, 'utf8')}\n# 快照应包含这一行\n`);

  const rolled = rollbackImport({ profileDir: profile, backup: imported.backup });
  assert.ok(rolled.preRollbackDir, '应返回 pre-rollback 目录');
  assert.ok(rolled.preRollbackFiles.includes('cordis.patch.yml'));

  // 备份被重命名为 .done 后，快照目录跟着搬走，但仍能读到
  const snapshot = path.join(rolled.backupArchived ?? rolled.backup, path.basename(rolled.preRollbackDir));
  const saved = fs.readFileSync(path.join(snapshot, 'cordis.patch.yml'), 'utf8');
  assert.match(saved, /快照应包含这一行/, '回滚前的文件内容要能取回');
});

test('回滚后扫描缓存失效（能看到真实状态）', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('cache-clear');
  const imported = importBundle({ file: bundle.file, profileDir: profile });

  const { scanProfile } = await import('../lib/scan.js');
  const before = await scanProfile({ profileDir: profile, dshHome: path.join(TMP, 'home') });
  const hadPlugin = before.plugins.some((plugin) => plugin.name === 'dsh-plugin-pack');
  assert.equal(hadPlugin, true, '导入后应能看到插件');

  rollbackImport({ profileDir: profile, backup: imported.backup });

  const after = await scanProfile({ profileDir: profile, dshHome: path.join(TMP, 'home') });
  const stillThere = after.plugins.some((plugin) => plugin.name === 'dsh-plugin-pack');
  assert.equal(stillThere, false, '回滚后应立刻看不到（缓存失效生效）');
});

test('老备份（没有精准记录）仍然整份还原，但也会先存快照', async () => {
  const bundle = await makeBundle();
  const profile = makeProfile('legacy-backup');
  const imported = importBundle({ file: bundle.file, profileDir: profile });

  // 手工把 record 里的精准字段删掉，模拟旧版本生成的备份
  const recordFile = path.join(imported.backup, 'record.json');
  const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  delete record.pkgDepsBefore;
  delete record.pkgBundlesAdded;
  delete record.patchAppended;
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));

  const rolled = rollbackImport({ profileDir: profile, backup: imported.backup });
  assert.equal(rolled.mode, 'full', '没有精准记录时应说明是整份还原');
  assert.ok(rolled.preRollbackDir, '即使是整份还原，也要先存当前快照');
  assert.ok(
    rolled.restored.some((item) => /整份还原/.test(item)),
    '结果里应写明是整份还原，让用户知道风险',
  );
});
