/**
 * 热加载的真实行为测试。
 *
 * 用假 registry 精确复刻宿主 dsh-client-modules 的关键行为：
 *   - pkgMeta 缓存否定结论，命中就返回，不重读 package.json
 *   - dirty + flush → processOne → resolveSource → resolveMeta
 *   - table 只收录通过的包，rebuilt 只对已入表的生效
 *
 * 断言：清缓存 + 标 dirty + flush 之后，原本被否掉的包能进表。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { reloadClientPackage, clientStatus, localVerdict, keysForPackage, getRegistry } from '../hotload.js';

/** 仓库根目录（不写死机器路径）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(os.tmpdir(), 'dsh-plugin-pack-hotload');

/** 造一个完整的假插件目录。 */
function makePackage(options = {}) {
  const name = options.name ?? 'fake-plugin';
  const withClientExport = options.withClientExport ?? true;
  const platform = options.platform ?? 'web';
  const clientBytes = options.clientBytes ?? 'module.exports=1;';
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  const pkg = {
    name,
    version: '1.0.0',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      ...(withClientExport ? { './client': './client.js' } : {}),
      './package.json': './package.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      ...(platform ? { client: { platform, inject: ['slots', 'locale'] } } : {}),
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const name = "x";\n');
  fs.writeFileSync(path.join(dir, 'client.js'), clientBytes);
  return dir;
}

/**
 * 假 ClientModuleRegistry：行为对齐宿主。
 */
function makeRegistry({ baseUrl = 'file:///C:/profile/cordis.yml' } = {}) {
  const registry = {
    pkgMeta: new Map(), // sourceKey -> meta | null（否定缓存）
    dirty: new Set(),
    table: new Map(), // id -> record
    rebuildListeners: new Set(),
    graphListeners: new Set(),
    resolveCount: 0,

    sourceKey(loaderName) {
      return `${baseUrl}\0${loaderName}`;
    },

    /** 复刻 resolveMeta：命中缓存直接返回，不重读。 */
    resolveMeta(loaderName) {
      const key = this.sourceKey(loaderName);
      if (this.pkgMeta.has(key)) return this.pkgMeta.get(key);
      this.resolveCount += 1;
      const located = this.locate(loaderName);
      if (!located) {
        this.pkgMeta.set(key, null);
        return null;
      }
      const pkg = JSON.parse(fs.readFileSync(located.path, 'utf8'));
      const decl = pkg.dsh?.client;
      if (!decl || decl.platform !== 'web') {
        this.pkgMeta.set(key, null);
        return null;
      }
      let rel = pkg.exports?.['./client'];
      if (rel && typeof rel === 'object') rel = rel.default;
      if (typeof rel !== 'string') throw new Error(`${pkg.name} declares dsh.client but exports no "./client" bundle`);
      const meta = { clientPath: path.join(path.dirname(located.path), rel.replace(/^\.\//, '')), inject: decl.inject, immediately: decl.immediately === true };
      this.pkgMeta.set(key, { packageName: pkg.name, meta });
      return { packageName: pkg.name, meta };
    },

    locate(loaderName) {
      // 只认 TMP 下的包
      const dir = path.join(TMP, loaderName);
      const file = path.join(dir, 'package.json');
      return fs.existsSync(file) ? { path: file } : null;
    },

    flush(onError) {
      let changed = false;
      for (const entryName of [...this.dirty]) {
        this.dirty.delete(entryName);
        try {
          if (this.processOne(entryName, onError)) changed = true;
        } catch (error) {
          onError(error);
        }
      }
      return changed;
    },

    processOne(entryName) {
      const source = this.resolveMeta(entryName);
      if (!source) {
        const had = this.table.delete(source?.packageName ?? entryName);
        return had;
      }
      const { packageName, meta } = source;
      const existing = this.table.get(packageName);
      if (existing && existing.sourceKey === this.sourceKey(entryName)) return false;
      if (!fs.existsSync(meta.clientPath)) throw new Error(`missing bundle ${meta.clientPath}`);
      this.table.set(packageName, { sourceKey: this.sourceKey(entryName), meta, entry: { id: packageName, rev: 'rev0' } });
      return true;
    },

    rebuilt(id) {
      const record = this.table.get(id);
      if (!record) return undefined;
      const next = `rev${Date.now()}`;
      record.entry = { id, rev: next };
      for (const notify of this.rebuildListeners) notify(id, next);
      return next;
    },

    get composed() {
      return { entries: [...this.table.values()].map((r) => r.entry), bootstrapIds: [...this.table.keys()] };
    },
  };
  return registry;
}

/** 造一个带 get() 的假 ctx。 */
function makeCtx(registry) {
  return {
    get(name) {
      return name === 'clientModules' ? registry : undefined;
    },
  };
}

test('缺 ./client 导出会让宿主抛错；补上后必须清缓存才生效', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = makePackage({ name: 'pkg-broken', withClientExport: false });

  const verdict1 = localVerdict(dir);
  assert.equal(verdict1.ok, false);
  assert.match(verdict1.error, /".\/client"/);

  const registry = makeRegistry();
  const ctx = makeCtx(registry);

  // 宿主对"声明了 dsh.client 却没有 ./client"是硬抛错（不是静默缓存 null）
  registry.dirty.add('pkg-broken');
  const thrown = [];
  registry.flush((error) => thrown.push(String(error?.message ?? error)));
  assert.equal(thrown.length, 1);
  assert.match(thrown[0], /exports no/);
  assert.equal(registry.table.has('pkg-broken'), false);

  // 补上 exports 后热加载应成功
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.exports['./client'] = './client.js';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

  const result = reloadClientPackage(ctx, { packageName: 'pkg-broken', packageDir: dir });
  assert.equal(result.ok, true, `补上 exports 后应成功: ${JSON.stringify(result)}`);
  assert.equal(registry.table.has('pkg-broken'), true);
});

test('否定缓存（platform 不对）被清掉后仍然拒绝，但会重读 package.json', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = makePackage({ name: 'pkg-plat', platform: 'desktop' });
  const registry = makeRegistry();
  const ctx = makeCtx(registry);

  // 第一次：platform 不是 web → 缓存 null
  registry.dirty.add('pkg-plat');
  registry.flush(() => {});
  assert.equal(registry.table.has('pkg-plat'), false);
  assert.equal(registry.pkgMeta.get(registry.sourceKey('pkg-plat')), null, '否定结论应被缓存');
  const resolvedOnce = registry.resolveCount;
  assert.equal(resolvedOnce, 1);

  // 缓存生效中：不会再解析第二次
  registry.dirty.add('pkg-plat');
  registry.flush(() => {});
  assert.equal(registry.resolveCount, resolvedOnce, '缓存命中时不应重读 package.json');

  // 改成 web 后热加载：应清缓存并重读到新值
  const pkgFile = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  pkg.dsh.client.platform = 'web';
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

  const result = reloadClientPackage(ctx, { packageName: 'pkg-plat', packageDir: dir });
  assert.equal(result.ok, true, `改成 web 后应成功: ${JSON.stringify(result)}`);
  assert.ok(result.clearedCaches >= 1, '应清掉缓存');
  assert.ok(registry.resolveCount > resolvedOnce, '应重新读过 package.json');
  assert.equal(registry.table.has('pkg-plat'), true);
});

test('platform 不是 web 时热加载也拉不起来（并给出原因）', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = makePackage({ name: 'pkg-desktop', platform: 'desktop' });
  const registry = makeRegistry();
  const result = reloadClientPackage(makeCtx(registry), { packageName: 'pkg-desktop', packageDir: dir });

  const verdict = localVerdict(dir);
  assert.equal(verdict.ok, false);
  assert.match(verdict.error, /platform=desktop/);
  assert.equal(result.ok, false);
  assert.equal(registry.table.has('pkg-desktop'), false);
});

test('keysForPackage 能按包名和目录命中 pkgMeta 的复合 key', () => {
  const registry = makeRegistry({ baseUrl: 'file:///base' });
  const packageDir = REPO_ROOT;
  registry.pkgMeta.set('file:///base\0dsh-plugin-pack', null);
  // 路径形态的 loader 行（patch 里写死绝对路径时会出现）
  registry.pkgMeta.set(`file:///base\0${packageDir}/index.js`, null);
  registry.pkgMeta.set('file:///base\0other-plugin', null);

  const { sourceKeys, loaderNames } = keysForPackage(registry, 'dsh-plugin-pack', packageDir);
  assert.equal(sourceKeys.length, 2);
  assert.deepEqual(loaderNames.sort(), [`${packageDir}/index.js`, 'dsh-plugin-pack'].sort());
});

test('clientStatus 准确报告入表状态与 rev', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  const dir = makePackage({ name: 'pkg-status' });
  const registry = makeRegistry();
  const ctx = makeCtx(registry);

  const before = clientStatus(ctx, 'pkg-status');
  assert.equal(before.available, true);
  assert.equal(before.inTable, false);
  assert.equal(before.rev, null);

  reloadClientPackage(ctx, { packageName: 'pkg-status', packageDir: dir });

  const after = clientStatus(ctx, 'pkg-status');
  assert.equal(after.inTable, true);
  assert.ok(after.rev, '应有 rev');
  assert.ok(after.clientPath.endsWith('client.js'));
  assert.ok(after.entries.includes('pkg-status'));
});

test('没有 clientModules 服务时给出明确错误而不是崩溃', () => {
  const result = reloadClientPackage({}, { packageName: 'x', packageDir: 'D:/none' });
  assert.equal(result.ok, false);
  assert.match(result.error, /clientModules/);
});

test('getRegistry 兼容 ctx.get 与直接属性两种暴露方式', () => {
  const registry = makeRegistry();
  assert.equal(getRegistry(makeCtx(registry)), registry);
  assert.equal(getRegistry({ clientModules: registry }), registry);
  assert.equal(getRegistry({}), null);
  assert.equal(getRegistry(null), null);
});

test('自热加载对真实插件目录可用（前提是声明完整）', () => {
  const realDir = REPO_ROOT;
  const verdict = localVerdict(realDir);
  assert.equal(verdict.ok, true, `自己的声明应完整: ${verdict.error ?? ''}`);
  assert.equal(verdict.name, 'dsh-plugin-pack');
  assert.ok(verdict.bytes > 10000, `client.js 应有内容，实际 ${verdict.bytes} 字节`);
  assert.deepEqual(verdict.inject, ['slots', 'locale']);
  assert.equal(verdict.immediately, true);
});
