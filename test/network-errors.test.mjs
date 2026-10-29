/**
 * 网络错误的可读化。
 *
 * 原来网络不通只抛 `TypeError: fetch failed`，用户不知道是网断了、
 * 域名错了、被墙了，还是代理没起。
 *
 * 现在按 error.cause 里的真实原因翻译成中文，并给一条能动手的建议。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { explainNetworkError } from '../lib/fetch-bundle.js';

/** 造一个 Node fetch 风格的错误（TypeError + cause）。 */
function netError(code, message) {
  const cause = new Error(message ?? code);
  cause.code = code;
  const error = new TypeError('fetch failed');
  error.cause = cause;
  return error;
}

const URL_GH = 'https://github.com/owner/repo/archive.zip';
const URL_NPM = 'https://registry.npmjs.org/dsh-plugin-pack';

test('DNS 解析失败 → 提示检查域名', () => {
  const e = explainNetworkError(netError('ENOTFOUND', 'getaddrinfo ENOTFOUND nope.invalid'), 'https://nope.invalid/x.zip');
  assert.equal(e.code, 'NETWORK');
  assert.match(e.message, /解析不了域名/);
  assert.match(e.message, /nope\.invalid/);
  assert.match(e.hint, /拼错|DNS/);
});

test('连接被重置 → GitHub 场景提示挂代理', () => {
  const e = explainNetworkError(netError('ECONNRESET', 'socket hang up'), URL_GH);
  assert.match(e.message, /连接被重置/);
  assert.match(e.hint, /代理/, 'GitHub 被重置时应提示挂代理');
});

test('连接被重置（非 GitHub）→ 提示检查网络稳定性', () => {
  const e = explainNetworkError(netError('ECONNRESET', 'socket hang up'), 'https://example.com/x.zip');
  assert.match(e.message, /连接被重置/);
  assert.doesNotMatch(e.hint, /GitHub/);
  assert.match(e.hint, /网络/);
});

test('超时 → 提示稍后重试或换网络', () => {
  const timeout = new Error('The operation was aborted');
  timeout.name = 'AbortError';
  const e = explainNetworkError(timeout, URL_NPM);
  assert.match(e.message, /超时/);
  assert.match(e.hint, /重试|网络/);
});

test('UND_ERR_CONNECT_TIMEOUT 也识别为超时', () => {
  const e = explainNetworkError(netError('UND_ERR_CONNECT_TIMEOUT', 'connect timeout'), URL_NPM);
  assert.match(e.message, /超时/);
});

test('拒绝连接 → 提示代理端口可能没起', () => {
  const e = explainNetworkError(netError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:7890'), URL_NPM);
  assert.match(e.message, /连不上/);
  assert.match(e.hint, /代理/);
});

test('网络不可达 → 归类为连不上', () => {
  const e = explainNetworkError(netError('ENETUNREACH', 'network is unreachable'), URL_NPM);
  assert.match(e.message, /连不上/);
});

test('证书错误 → 提示中间人代理或系统时间', () => {
  const e = explainNetworkError(netError('CERT_HAS_EXPIRED', 'certificate has expired'), URL_GH);
  assert.match(e.message, /证书/);
  assert.match(e.hint, /代理|时间/);
});

test('代理错误 → 提示检查代理环境变量', () => {
  const e = explainNetworkError(netError('ERR_PROXY', 'proxy connection failed'), URL_NPM);
  assert.match(e.message, /代理/);
  assert.match(e.hint, /HTTP_PROXY|系统代理/);
});

test('未知错误 → 兜底也带上原始信息，不吞掉', () => {
  const e = explainNetworkError(netError('EWEIRD', 'something odd happened'), URL_NPM);
  assert.match(e.message, /网络出错/);
  assert.match(e.hint, /something odd happened/, '兜底应保留原始 message');
});

test('阶段名会出现在文案里，能看出是哪一步失败', () => {
  const e = explainNetworkError(netError('ENOTFOUND'), URL_NPM, '查 npm 包');
  assert.match(e.message, /^查 npm 包失败/);
});

test('URL 解析不了也不崩，按原样当 host 显示', () => {
  const e = explainNetworkError(netError('ECONNRESET'), 'not-a-url');
  assert.equal(e.code, 'NETWORK');
  assert.match(e.message, /not-a-url/);
});

test('界面源码：错误下面会显示处置建议', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
  assert.ok(src.includes('net.hintTitle'), '应有「可以这样处理」标题');
  assert.ok(/result\.hint/.test(src), '应渲染服务端给的 hint');
  assert.ok(/if \(data\?\.hint\) error\.hint/.test(src), 'api() 应把 hint 带到错误对象上');
});
