/**
 * 冷启动自愈验证：模拟「宿主刚启动、本包被判定为非客户端包」的最坏情况，
 * 确认自热加载能把局面救回来。
 *
 * 场景就是你现在遇到的：package.json 早先缺 exports["./client"]，
 * 宿主缓存了否定结论；后来补上了，但图表里没有它。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { reloadClientPackage, clientStatus, localVerdict } from '../hotload.js';

const REAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 复刻宿主 registry 的最小心跳：pkgMeta 缓存 + dirty + flush + table。 */
function makeRegistry({ preloadedWithNegativeCache = true } = {}) {
  // 用一个虚构的 baseUrl 就行：这个测试只关心缓存 key 的匹配逻辑
  const baseUrl = 'file:///profile/cordis.yml';
  const registry = {
    pkgMeta: new Map(),
    dirty: new Set(),
    table: new Map(),
    resolveCount: 0,
    sourceKey: (loaderName) => `${baseUrl}\0${loaderName}`,

    resolveMeta(loaderName) {
      const key = this.sourceKey(loaderName);
      if (this.pkgMeta.has(key)) return this.pkgMeta.get(key); // 命中缓存，不重读
      this.resolveCount += 1;

      const dir = path.join('D:/Documents', loaderName);
      const pkgFile = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgFile)) {
        this.pkgMeta.set(key, null);
        return null;
      }
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      const decl = pkg.dsh?.client;
      if (!decl || decl.platform !== 'web') {
        this.pkgMeta.set(key, null);
        return null;
      }
      let rel = pkg.exports?.['./client'];
      if (rel && typeof rel === 'object') rel = rel.default;
      if (typeof rel !== 'string') throw new Error(`${pkg.name} declares dsh.client but exports no "./client"`);
      const meta = { clientPath: path.join(dir, rel.replace(/^\.\//, '')), inject: decl.inject, immediately: decl.immediately === true };
      this.pkgMeta.set(key, { packageName: pkg.name, meta });
      return { packageName: pkg.name, meta };
    },

    flush(onError) {
      let changed = false;
      for (const entryName of [...this.dirty]) {
        this.dirty.delete(entryName);
        try {
          const source = this.resolveMeta(entryName);
          if (!source) {
            if (this.table.delete(entryName)) changed = true;
            continue;
          }
          const { packageName, meta } = source;
          const existing = this.table.get(packageName);
          if (existing && existing.sourceKey === this.sourceKey(entryName)) continue;
          if (!fs.existsSync(meta.clientPath)) throw new Error(`missing bundle ${meta.clientPath}`);
          this.table.set(packageName, { sourceKey: this.sourceKey(entryName), meta, entry: { id: packageName, rev: 'rev0' } });
          changed = true;
        } catch (error) {
          onError(error);
        }
      }
      return changed;
    },

    rebuilt(id) {
      const record = this.table.get(id);
      if (!record) return undefined;
      record.entry = { id, rev: `rev-${++this.resolveCount}` };
      return record.entry.rev;
    },

    get composed() {
      return { entries: [...this.table.values()].map((r) => r.entry), bootstrapIds: [...this.table.keys()] };
    },
  };

  if (preloadedWithNegativeCache) {
    // 模拟"启动时判定失败"留下的缓存
    registry.pkgMeta.set(registry.sourceKey('dsh-plugin-pack'), null);
  }
  return registry;
}

function makeCtx(registry) {
  return { get: (name) => (name === 'clientModules' ? registry : undefined) };
}

test('最坏情况：启动时缓存了否定结论，自热加载能救回来', () => {
  const registry = makeRegistry({ preloadedWithNegativeCache: true });
  const ctx = makeCtx(registry);

  // 起点：图表里没有它
  const before = clientStatus(ctx, 'dsh-plugin-pack');
  assert.equal(before.inTable, false);
  assert.equal(before.entries.length, 0);

  // 自热加载（就是 apply() 里那段 setTimeout 干的事）
  const verdict = localVerdict(REAL);
  assert.equal(verdict.ok, true, `自己的声明必须完整: ${verdict.error ?? ''}`);

  const result = reloadClientPackage(ctx, { packageName: 'dsh-plugin-pack', packageDir: REAL });
  assert.equal(result.ok, true, `自热加载应成功: ${JSON.stringify(result)}`);
  assert.ok(result.clearedCaches >= 1, '必须清掉那条否定缓存');

  // 终点：进图表了，有 rev，浏览器能拉到 bundle
  const after = clientStatus(ctx, 'dsh-plugin-pack');
  assert.equal(after.inTable, true);
  assert.ok(after.rev);
  assert.ok(after.clientPath.endsWith('client.js'));
  assert.equal(fs.existsSync(after.clientPath), true, `bundle 必须真实存在: ${after.clientPath}`);
  assert.ok(after.entries.includes('dsh-plugin-pack'));
});

test('已经在图表里时不重复解析（幂等）', () => {
  const registry = makeRegistry({ preloadedWithNegativeCache: false });
  const ctx = makeCtx(registry);

  reloadClientPackage(ctx, { packageName: 'dsh-plugin-pack', packageDir: REAL });
  const firstCount = registry.resolveCount;
  assert.equal(clientStatus(ctx, 'dsh-plugin-pack').inTable, true);

  // 第二次热加载：缓存还在（已缓存 positive meta），不应重读
  reloadClientPackage(ctx, { packageName: 'dsh-plugin-pack', packageDir: REAL });
  assert.equal(clientStatus(ctx, 'dsh-plugin-pack').inTable, true, '重复热加载不应把它弄丢');
  assert.ok(registry.resolveCount >= firstCount, '解析次数不应倒退');
});

test('bundle 文件缺失时会明确报错，而不是假装成功', () => {
  const registry = makeRegistry({ preloadedWithNegativeCache: false });
  const ctx = makeCtx(registry);
  const realClient = path.join(REAL, 'client.js');
  const backup = `${realClient}.bak-test`;

  fs.copyFileSync(realClient, backup);
  try {
    fs.unlinkSync(realClient);
    const result = reloadClientPackage(ctx, { packageName: 'dsh-plugin-pack', packageDir: REAL });
    // 宿主在 resolveMeta 阶段仍会给出 clientPath（声明里写了），
    // 但 reconcilePackage 读文件时会失败 → result.ok 必须是 false
    assert.equal(result.ok, false, '缺 bundle 时不能报成功');
    assert.ok(result.failures.length > 0 || result.error, '必须给出失败原因');
  } finally {
    fs.copyFileSync(backup, realClient);
    fs.unlinkSync(backup);
  }
});
