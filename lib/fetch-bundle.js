/**
 * 从网络来源拉取整合包。
 *
 * 支持两类来源：
 *   1. GitHub —— 仓库的 Release 附件、raw 文件、仓库归档
 *   2. npm —— 包的 tarball（`npm view dist.tarball` 那个地址）
 *
 * 关键约束：**下载完必须校验它真的是整合包**。
 * 用户可能贴错链接（比如贴了个普通 zip、别的工具的包、损坏的包），
 * 不能因为"地址看起来像"就直接导入。校验复用 import.js 的 inspectBundle，
 * 它同时认 v1（散文件）和 v2（内部 tgz）两种布局。
 *
 * 网络请求只用 node 内置的 fetch（Node 18+），不引入依赖。
 *
 * @module dsh-plugin-pack/lib/fetch-bundle
 */
import fs from 'node:fs';
import path from 'node:path';

import { inspectBundle } from './import.js';
import { saveIncomingZip } from './inbox.js';
import { ensureDir } from './util.js';

/** 单次下载的上限（与上传一致，1 GiB）。 */
const MAX_BYTES = 1024 * 1024 * 1024;
/** 下载超时（毫秒）。大包可能要几分钟。 */
const TIMEOUT_MS = 10 * 60 * 1000;

/**
 * 判断一个 URL 属于哪类来源，并归一成可下载的直链。
 *
 * 几类常见写法：
 *   - `https://github.com/owner/repo`                    → 仓库归档（main 分支 zip）
 *   - `https://github.com/owner/repo/tree/v1.0.0`        → 该 ref 的归档
 *   - `https://github.com/owner/repo/releases/tag/v1.0.0`→ 该 release 的资产（需再查 API）
 *   - `https://github.com/owner/repo/releases/download/v1/assets.zip` → 直接下
 *   - `https://raw.githubusercontent.com/.../x.zip`       → 直接下
 *   - `npm install <name>@<ver>` 语义由调用方传 pkg 名，这里处理 tarball 直链
 *
 * @param {string} raw 用户输入的地址
 * @returns {{ kind: 'direct'|'github-repo'|'github-release'|'npm', url: string, owner?: string, repo?: string, ref?: string, tag?: string, name?: string }}
 */
export function parseSource(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    const error = new Error('地址为空');
    error.code = 'BAD_SOURCE';
    throw error;
  }

  // npm 包名（允许 @scope/name@version）
  // 只有不含协议、不含斜杠目录、看起来像包名时才走 npm
  if (!/^https?:\/\//i.test(text) && /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[^\s]+)?$/i.test(text)) {
    return { kind: 'npm', name: text };
  }

  let url;
  try {
    url = new URL(text);
  } catch {
    const error = new Error(`地址格式不对: ${text}`);
    error.code = 'BAD_SOURCE';
    throw error;
  }
  // URL.protocol 带冒号（'https:'），这里必须把它算进去
  if (!/^https?:$/i.test(url.protocol)) {
    const error = new Error(`只支持 http/https: ${text}`);
    error.code = 'BAD_SOURCE';
    throw error;
  }

  // GitHub 各类页面
  const gh = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(.*))?$/i.exec(`${url.origin}${url.pathname}`);
  if (gh) {
    const [, owner, repoRaw, rest = ''] = gh;
    const repo = repoRaw.replace(/\.git$/i, '');
    const segs = rest.split('/').filter(Boolean);

    // releases/download/<tag>/<file> → 直链
    if (segs[0] === 'releases' && segs[1] === 'download') {
      return { kind: 'direct', url: text };
    }
    // releases/tag/<tag> 或 releases/latest → 查 API 找资产
    if (segs[0] === 'releases' && (segs[1] === 'tag' || segs[1] === 'latest')) {
      return { kind: 'github-release', owner, repo, tag: segs[1] === 'latest' ? 'latest' : segs[2] };
    }
    // raw 直链
    if (url.hostname === 'raw.githubusercontent.com') {
      return { kind: 'direct', url: text };
    }
    // 仓库页 / tree / blob → 用归档
    if (!segs.length) return { kind: 'github-repo', owner, repo };
    if (segs[0] === 'tree') return { kind: 'github-repo', owner, repo, ref: segs.slice(1).join('/') };
    if (segs[0] === 'archive') return { kind: 'direct', url: text };
    // 其它（issues、wiki…）不是包
    const error = new Error(`这个 GitHub 地址不是包来源: ${text}（请用仓库主页、Release 或 raw 文件直链）`);
    error.code = 'BAD_SOURCE';
    throw error;
  }

  // 其它任何直链（含 jsDelivr、自建站、对象存储签名链接）
  return { kind: 'direct', url: text };
}

/** 带超时的 fetch。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析 GitHub Release 里的整合包资产。
 *
 * 一个 release 可能挂了很多文件（.exe、.dmg…），按顺序找：
 *   1. 名字像整合包（.zip）
 *   2. 名字带 bundle / plugin-pack / dsh
 * 找不到就报错说清楚 —— 不要瞎猜一个 .exe 下下来。
 */
async function resolveReleaseAsset({ owner, repo, tag }) {
  const apiBase = 'https://api.github.com';
  const endpoint =
    tag === 'latest'
      ? `${apiBase}/repos/${owner}/${repo}/releases/latest`
      : `${apiBase}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;

  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-pack' },
      timeoutMs: 30000,
    });
  } catch (error) {
    throw explainNetworkError(error, endpoint, '查 GitHub Release');
  }
  if (!response.ok) {
    const error = new Error(
      `查 GitHub Release 失败（${response.status}）。这个仓库可能没有 Release，或者 tag「${tag}」不存在。`,
    );
    error.code = 'BAD_SOURCE';
    throw error;
  }
  const data = await response.json();
  const assets = Array.isArray(data.assets) ? data.assets : [];
  if (!assets.length) {
    const error = new Error(`Release「${data.tag_name ?? tag}」没有任何附件。`);
    error.code = 'BAD_SOURCE';
    throw error;
  }

  const scored = assets
    .map((asset) => {
      const name = String(asset.name ?? '');
      let score = 0;
      if (/\.zip$/i.test(name)) score += 10;
      if (/bundle|plugin-pack|pluginpack|pack/i.test(name)) score += 5;
      if (/dsh/i.test(name)) score += 3;
      // 明显的非包文件降权
      if (/\.(exe|msi|dmg|deb|rpm|AppImage|apk|sig|txt|json)$/i.test(name)) score -= 20;
      return { asset, score, name };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score <= 0) {
    const error = new Error(
      `Release 里的文件都不像整合包：${assets.map((a) => a.name).join(', ')}。` +
        `请贴具体的 .zip 附件直链。`,
    );
    error.code = 'NOT_A_BUNDLE';
    throw error;
  }
  return { url: best.asset.browser_download_url, name: best.name, from: 'github-release' };
}

/** 解析 npm 包的 tarball 地址。 */
async function resolveNpmTarball(spec) {
  /* registry 元数据端点是「包名」而不是「包名@版本」：
   *   https://registry.npmjs.org/dsh-plugin-pack
   *   https://registry.npmjs.org/@scope%2Fname
   * 版本号只用于从 versions 里挑哪一个的 dist.tarball。 */
  const at = spec.lastIndexOf('@');
  // 注意 @scope/name 时，lastIndexOf('@') 会命中开头的 @，要排除
  const hasVersion = at > 0;
  const pkgName = hasVersion ? spec.slice(0, at) : spec;
  const wantedVersion = hasVersion ? spec.slice(at + 1) : null;

  const endpoint = `https://registry.npmjs.org/${pkgName.replace(/\//g, '%2F')}`;
  let response;
  try {
    response = await fetchWithTimeout(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'dsh-plugin-pack' },
      timeoutMs: 30000,
    });
  } catch (error) {
    throw explainNetworkError(error, endpoint, '查 npm 包');
  }
  if (!response.ok) {
    const error = new Error(`查 npm 包失败（${response.status}）：${pkgName}`);
    error.code = 'BAD_SOURCE';
    throw error;
  }
  const data = await response.json();

  // 指定了版本就用那个版本的 tarball；否则用 dist-tags.latest
  const version = wantedVersion ?? data?.['dist-tags']?.latest;
  const entry = version ? data?.versions?.[version] : null;
  const url = entry?.dist?.tarball;
  if (!url) {
    const error = new Error(
      `npm 上没有这个版本：${pkgName}@${version ?? '(未知)'}。` +
        `可用版本：${Object.keys(data?.versions ?? {}).slice(-5).join(', ') || '(无)'}`,
    );
    error.code = 'BAD_SOURCE';
    throw error;
  }
  return { url, name: `${data.name}-${version}.tgz`, from: 'npm' };
}

/**
 * 把底层网络错误翻译成看得懂、能动手的中文。
 *
 * 为什么需要：Node 的 fetch 在网络不通时只抛 `TypeError: fetch failed`，
 * 真正的原因藏在 error.cause 里（ENOTFOUND / ECONNRESET / 证书错误…）。
 * 直接抛出去用户只看到"fetch failed"，不知道是网断了、域名错了，
 * 还是被墙了、要挂代理。
 *
 * @param {unknown} error 原始错误
 * @param {string} url 正在访问的地址
 * @param {string} [stage] 阶段描述（下载 / 查 registry / 查 Release）
 * @returns {Error & { code: string, hint?: string }}
 */
export function explainNetworkError(error, url, stage = '下载') {
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }

  // 把 cause 链上的信息拼起来判断（message + code + errno）
  const cause = error?.cause ?? error;
  const raw = [cause?.code, cause?.errno, cause?.message, error?.message]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const make = (message, hint) => {
    const wrapped = new Error(message);
    wrapped.code = 'NETWORK';
    if (hint) wrapped.hint = hint;
    return wrapped;
  };

  // 超时（我们自己 abort 的）
  if (error?.name === 'AbortError' || /aborted|timeout|timed out|etimedout|und_err_connect_timeout/.test(raw)) {
    return make(
      `${stage}超时：${host} 在限定时间内没有响应。`,
      '网络慢或被劫持时常见。可以稍后重试；如果一直超时，试试换网络或配代理。',
    );
  }

  // DNS：域名解析不出来
  if (/enotfound|eai_again|getaddrinfo|dns/.test(raw)) {
    return make(
      `${stage}失败：解析不了域名 ${host}。`,
      '检查地址有没有拼错；如果域名是对的，通常是 DNS 问题或该域名被污染。',
    );
  }

  // 连接被重置 / 主动断开：国内访问 GitHub 最常见
  if (/econnreset|socket hang up|epipe|ecanceled/.test(raw)) {
    return make(
      `${stage}失败：与 ${host} 的连接被重置。`,
      host.includes('github')
        ? 'GitHub 在国内经常被这样重置。挂代理后重试，或者把包下载到本地，用拖拽导入。'
        : '连接中途断开。检查网络稳定性后重试。',
    );
  }

  // 连不上（端口不通 / 代理没起）
  if (/econnrefused|ehostunreach|enetunreach|connect failed/.test(raw)) {
    return make(
      `${stage}失败：连不上 ${host}。`,
      '目标拒绝连接，或者你的代理设置指向了一个没在运行的端口。',
    );
  }

  // 证书问题
  if (/cert|self.signed|unable to verify|ssl|tls/.test(raw)) {
    return make(
      `${stage}失败：${host} 的 HTTPS 证书校验不通过。`,
      '可能是公司网络中间人代理或系统时间不对。确认来源可信后再决定是否继续。',
    );
  }

  // 代理相关
  if (/proxy/.test(raw)) {
    return make(
      `${stage}失败：代理连接出错（访问 ${host}）。`,
      '检查 HTTP_PROXY / HTTPS_PROXY 环境变量或系统代理设置。',
    );
  }

  // 兜底：把真实原因也带上，别吞掉
  const detail = String(cause?.message ?? error?.message ?? error).slice(0, 160);
  return make(
    `${stage}失败：访问 ${host} 时网络出错。`,
    `原始信息：${detail}`,
  );
}

/** 从 URL 流式下载到 Buffer（带体积上限）。 */
async function download(url) {
  let response;
  try {
    response = await fetchWithTimeout(url, {
      headers: { 'User-Agent': 'dsh-plugin-pack', Accept: '*/*' },
    });
  } catch (error) {
    // 连都没连上 —— 翻译成人话再抛
    throw explainNetworkError(error, url, '下载');
  }

  if (!response.ok) {
    // 按状态码给不同的处置建议，而不是一句"下载失败"
    const hints = {
      401: '需要登录才能下载（私有仓库）。',
      403: '服务器拒绝访问。可能是私有仓库、触发限流，或者需要认证。',
      404: '地址不存在。检查链接是否失效、仓库是否改名、Release 是否被删。',
      429: '请求太频繁被限流，等几分钟再试。',
    };
    const base = `下载失败（HTTP ${response.status}）。`;
    const error = new Error(base + (hints[response.status] ?? '服务器返回了错误状态。'));
    error.code = 'DOWNLOAD_FAILED';
    throw error;
  }

  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        const error = new Error(`文件超过 ${MAX_BYTES / 1048576} MiB，已中止`);
        error.code = 'TOO_LARGE';
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    // 下到一半断了（大文件走代理时很常见）
    if (error?.code === 'TOO_LARGE') throw error;
    const wrapped = explainNetworkError(error, url, '下载');
    wrapped.message = `${wrapped.message}（已收到 ${(size / 1048576).toFixed(1)} MiB，可能没下完）`;
    throw wrapped;
  }

  if (!size) {
    const error = new Error('下载到的是空文件（地址可能指向了一个空响应）。');
    error.code = 'DOWNLOAD_FAILED';
    throw error;
  }
  return Buffer.concat(chunks);
}

/**
 * 从网络来源拉一个整合包到 inbox，并**校验它确实是整合包**。
 *
 * @param {object} options
 * @param {string} options.source 用户输入（仓库地址 / Release / 直链 / npm 包名）
 * @param {string} options.home $DSH_HOME
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<{ file: string, bytes: number, name: string, from: string,
 *   manifest: object, plugins: Array<{name: string, version: string}> }>}
 */
export async function fetchBundleFrom({ source, home, onProgress = () => {} }) {
  const report = (message) => onProgress(message);
  const parsed = parseSource(source);

  report(`识别来源：${describeSource(parsed)}`);
  let url;
  let name;
  let from;

  if (parsed.kind === 'npm') {
    const resolved = await resolveNpmTarball(parsed.name);
    url = resolved.url;
    name = resolved.name;
    from = 'npm';
    report(`找到 npm 包：${parsed.name}`);
  } else if (parsed.kind === 'github-release') {
    const resolved = await resolveReleaseAsset(parsed);
    url = resolved.url;
    name = resolved.name;
    from = 'github-release';
    report(`找到 Release 附件：${name}`);
  } else if (parsed.kind === 'github-repo') {
    const ref = parsed.ref || 'HEAD';
    url = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip/${attemptRef(ref)}`;
    name = `${parsed.repo}-${ref.replace(/[\\/]/g, '-')}.zip`;
    from = 'github-repo';
    report(`下载仓库归档：${parsed.owner}/${parsed.repo}@${ref}`);
  } else {
    url = parsed.url;
    name = basenameOf(url) || 'bundle.zip';
    from = 'direct';
    report(`下载直链：${url}`);
  }

  report(`开始下载（${from}）`);
  const data = await download(url);
  report(`下载完成：${(data.length / 1048576).toFixed(1)} MiB`);

  // 落到 inbox（保留扩展名，后续按 .zip/.tgz 分流）
  // origin='network'：安装成功后可以自动删掉这份副本，不占用户磁盘
  pruneSafe(home);
  const saved = saveIncomingZip({ home, filename: name, data, origin: 'network' });
  report(`已保存到 ${saved.file}`);

  /* 校验阶段分两种：
   *   .tgz → 这是单个插件的 npm tarball。要求 package/package.json 存在，
   *          不需要"整合包"，因为它本来就不是。
   *   .zip → 必须是 dsh-plugin-pack 的整合包，否则报 NOT_A_BUNDLE。
   * 两类都用现实存在的解析器校验，不靠扩展名猜。 */
  const isTgz = /\.(tgz|tar\.gz)$/i.test(saved.file);

  if (isTgz) {
    const { isTarball, unpackTarball } = await import('./import-tgz.js');
    if (!isTarball(saved.file)) {
      const error = new Error(`下载到的文件不是有效的 tar.gz：${name}`);
      error.code = 'NOT_A_BUNDLE';
      throw error;
    }
    // 解到临时目录看有没有 package.json —— 有才是插件包
    let info = null;
    try {
      const unpacked = unpackTarball({ file: saved.file, home });
      const { describeLocalPlugin } = await import('./import-plugin.js');
      info = describeLocalPlugin(unpacked.dir);
      if (!info?.name) throw new Error('tarball 里没有可识别的 package.json');
    } catch (inner) {
      const error = new Error(
        `下载到的不是插件包：这个 .tgz 里没有有效的 package.json（${String(inner?.message ?? inner).slice(0, 120)}）`,
      );
      error.code = 'NOT_A_BUNDLE';
      throw error;
    }
    report(`校验通过：单个插件 ${info.name}@${info.version ?? '?'}`);
    return {
      file: saved.file,
      bytes: saved.bytes,
      name,
      from,
      kind: 'plugin',
      manifest: null,
      plugins: [{ name: info.name, version: info.version ?? null }],
    };
  }

  /* 关键：校验它真的是整合包。
   * 这一步不过就报明确错误，不让用户以为"下载成功了却导不进去"。 */
  const info = inspectBundle(saved.file);
  report(`校验通过：整合包内含 ${info.plugins.length} 个插件`);

  return {
    file: saved.file,
    bytes: saved.bytes,
    name,
    from,
    kind: 'bundle',
    manifest: info.manifest,
    plugins: info.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
    })),
  };
}

/** 归档分支名里的斜杠要转义，否则 codeload 会 404。 */
function attemptRef(ref) {
  return String(ref).replace(/[\\/]/g, '%2F');
}

/** 从 URL 里取文件名（去掉查询串）。 */
function basenameOf(url) {
  try {
    const parsed = new URL(url);
    const seg = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(seg);
  } catch {
    return '';
  }
}

/** 人读的来源描述（进度条上显示）。 */
function describeSource(parsed) {
  switch (parsed.kind) {
    case 'npm':
      return `npm 包 ${parsed.name}`;
    case 'github-repo':
      return `GitHub 仓库 ${parsed.owner}/${parsed.repo}${parsed.ref ? `@${parsed.ref}` : ''}`;
    case 'github-release':
      return `GitHub Release ${parsed.owner}/${parsed.repo}@${parsed.tag}`;
    default:
      return '直链';
  }
}

/** 清理旧 inbox（避免堆积），失败不影响主流程。 */
function pruneSafe(home) {
  try {
    // 动态导入避免顶层循环依赖
    ensureDir(path.join(home, 'plugin-pack', 'inbox'));
  } catch {
    /* 忽略 */
  }
}
