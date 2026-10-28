/**
 * 用假的 request/response 打通所有 HTTP 路由，验证服务端逻辑端到端可用。
 *
 * 不依赖真实 dsh 进程：把 ctx.inject('webServer') 的回调直接抓出来，
 * 用内存里的 req/res 桩调 handler。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { mountRoutes, snapshot, browse } from '../lib/server.js';

/** 最小 request 桩。 */
function makeRequest(method, urlPath, body, headers = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
  const chunks = payload ? [payload] : [];
  return {
    method,
    url: urlPath,
    headers: { host: '127.0.0.1:7764', ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** 最小 response 桩。 */
function makeResponse() {
  const state = { status: 0, headers: null, body: '' };
  return {
    state,
    writeHead(status, headers) {
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      state.body = body ?? '';
    },
    json() {
      return state.body ? JSON.parse(state.body) : null;
    },
  };
}

/** 抓出所有注册的路由。 */
function collectRoutes() {
  const routes = new Map();
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['webServer']);
      const host = {
        effect(fn) {
          fn();
        },
        webServer: {
          register(spec, label) {
            routes.set(spec.path, { spec, label });
            return () => routes.delete(spec.path);
          },
        },
      };
      callback(host);
    },
  };
  mountRoutes(ctx, {});
  return routes;
}

async function call(routes, urlPath, method = 'GET', body) {
  const route = routes.get(urlPath);
  assert.ok(route, `路由没注册: ${urlPath}`);
  const request = makeRequest(method, urlPath, body);
  const response = makeResponse();
  await route.spec.handler(request, response);
  return { status: response.state.status, data: response.json(), response };
}

test('所有路由都注册上了', () => {
  const routes = collectRoutes();
  const expected = [
    '/plugin-pack/status',
    '/plugin-pack/export',
    '/plugin-pack/inspect',
    '/plugin-pack/import',
    '/plugin-pack/rollback',
    '/plugin-pack/browse',
    '/plugin-pack/config',
  ];
  for (const pathname of expected) assert.ok(routes.has(pathname), `缺少 ${pathname}`);
});

test('GET status 返回完整快照', async () => {
  const routes = collectRoutes();
  const { status, data } = await call(routes, '/plugin-pack/status');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.plugins.length > 0, '应至少扫到一个插件');
  assert.ok(Array.isArray(data.backups));
  assert.ok(Array.isArray(data.recentExports));
  assert.ok(data.profile.name);
  assert.ok(data.totals.bytesText);
  // 界面需要的字段都在
  for (const plugin of data.plugins) {
    assert.ok(plugin.name);
    assert.ok(typeof plugin.bytes === 'number');
    assert.ok(plugin.bytesText);
    assert.ok(Array.isArray(plugin.warnings));
  }
});

test('status 拒绝 POST', async () => {
  const routes = collectRoutes();
  const { status } = await call(routes, '/plugin-pack/status', 'POST', {});
  assert.equal(status, 405);
});

test('export dryRun 只算体积不写文件', async () => {
  const routes = collectRoutes();
  // 用当前的 DSH_HOME（由环境决定），不写死机器路径
  const exportsDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'exports');
  const before = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0;
  const { status, data } = await call(routes, '/plugin-pack/export', 'POST', {
    include: ['dsh-plugin-pack'],
    dryRun: true,
  });
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.ok, true);
  assert.equal(data.dryRun, true);
  assert.ok(data.bytes > 0);
  assert.equal(data.plugins.length, 1);
  const after = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir).length : 0;
  assert.equal(before, after, 'dryRun 不应写出文件');
});

test('browse 默认不创建目录；带 create:true 才创建', async () => {
  const routes = collectRoutes();
  const probe = path.join(os.tmpdir(), `pp-browse-${Date.now()}`, 'nested');

  // 默认：不存在就报 404，绝不偷偷建目录（粘错路径不该留下空壳）
  const missing = await call(routes, '/plugin-pack/browse', 'POST', { dir: probe });
  assert.equal(missing.status, 404, JSON.stringify(missing.data));
  assert.equal(fs.existsSync(probe), false, '不该创建目录');

  // 显式 create：导出目标目录需要这个
  const created = await call(routes, '/plugin-pack/browse', 'POST', { dir: probe, create: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.ok, true);
  assert.ok(fs.existsSync(probe), '目录应被创建');

  fs.rmSync(path.dirname(probe), { recursive: true, force: true });
});

test('browse 列出目录与父级', async () => {
  const result = browse(os.tmpdir());
  assert.equal(result.ok, true);
  assert.equal(result.dir, 'D:\\Temp');
  assert.ok(Array.isArray(result.items));
  assert.ok(result.parent);
  // 目录排在文件前面
  const firstFile = result.items.findIndex((item) => !item.dir);
  const lastDir = result.items.reduce((acc, item, index) => (item.dir ? index : acc), -1);
  if (firstFile >= 0 && lastDir >= 0) assert.ok(lastDir < firstFile);
});

test('跨站请求被拒绝', async () => {
  const routes = collectRoutes();
  const request = makeRequest('GET', '/plugin-pack/status', undefined, {
    'sec-fetch-site': 'cross-site',
  });
  const response = makeResponse();
  await routes.get('/plugin-pack/status').spec.handler(request, response);
  assert.equal(response.state.status, 403);
});

test('inspect 缺 file 参数返回 400', async () => {
  const routes = collectRoutes();
  const { status } = await call(routes, '/plugin-pack/inspect', 'POST', {});
  assert.equal(status, 400);
});

test('inspect 不存在的包返回 404', async () => {
  const routes = collectRoutes();
  const { status, data } = await call(routes, '/plugin-pack/inspect', 'POST', { file: path.join(os.tmpdir(), 'nope-xyz.zip') });
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

test('config 读写成对', async () => {
  const routes = collectRoutes();
  const read1 = await call(routes, '/plugin-pack/config');
  assert.equal(read1.status, 200);
  const write = await call(routes, '/plugin-pack/config', 'POST', { defaultOut: os.tmpdir() });
  assert.equal(write.status, 200);
  assert.equal(write.data.settings.defaultOut, os.tmpdir());
  const read2 = await call(routes, '/plugin-pack/config');
  assert.equal(read2.data.settings.defaultOut, os.tmpdir());
});

test('snapshot 里的 dataCandidates 是数组', async () => {
  const data = await snapshot({});
  for (const plugin of data.plugins) {
    assert.ok(Array.isArray(plugin.dataCandidates));
  }
  assert.ok(data.settings);
  assert.ok(typeof data.settings.maxBytes === 'number');
});
