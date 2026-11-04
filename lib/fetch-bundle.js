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
import { readZip } from './zip.js';
import { readLinkBundle } from './link-bundle.js';

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
    /* github.com/<owner>/<repo>/(raw|blob)/<ref>/<path>
     * 这是网页上复制出来的文件地址。它 302 跳到 raw.githubusercontent.com，
     * 而那个域名在国内经常被重置 —— 所以这里改成走 api.github.com 取内容。 */
    if ((segs[0] === 'raw' || segs[0] === 'blob') && segs.length >= 3) {
      return {
        kind: 'github-file',
        owner,
        repo,
        ref: segs[1],
        path: segs.slice(2).join('/'),
      };
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

  // api.github.com 的 contents 地址也认
  if (/^https:\/\/api\.github\.com\/repos\//i.test(text)) {
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/i.exec(text);
    if (api) {
      const [, owner, repo, rest] = api;
      const [pathPart, query = ''] = rest.split('?');
      const ref = /[?&]ref=([^&]+)/.exec(query)?.[1];
      return { kind: 'github-file', owner, repo, ref: ref ? decodeURIComponent(ref) : null, path: decodeURIComponent(pathPart) };
    }
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

/**
 * 通过 api.github.com 取单个文件的内容。
 *
 * 为什么不用 raw.githubusercontent.com：那个域名在国内经常被重置，
 * 而 api.github.com 通常可达。小文件走 contents 接口（返回 base64），
 * 超过 1 MB 时 contents 会拒绝，改走 git trees + blobs。
 *
 * @param {{ owner: string, repo: string, ref: string|null, path: string }} options
 * @returns {Promise<Buffer>}
 */
async function downloadGithubFile({ owner, repo, ref, path: filePath }) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-plugin-pack',
  };
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${refQuery}`;

  let firstError = null;
  try {
    const response = await fetchWithTimeout(contentsUrl, { headers }, 60000);
    if (response.ok) {
      const data = await response.json();
      if (data?.content && data.encoding === 'base64') {
        return Buffer.from(String(data.content).replace(/\n/g, ''), 'base64');
      }
    } else {
      firstError = `contents 接口返回 ${response.status}`;
    }
  } catch (error) {
    firstError = String(error?.message ?? error);
  }

  // 大文件：trees → blobs
  try {
    const treeRef = ref || 'HEAD';
    const treeResponse = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(treeRef)}?recursive=1`,
      { headers },
      60000,
    );
    if (!treeResponse.ok) throw new Error(`trees 接口返回 ${treeResponse.status}`);
    const tree = await treeResponse.json();
    const node = (tree?.tree ?? []).find((item) => item.path === filePath);
    if (!node) throw new Error(`仓库里没有这个文件: ${filePath}`);

    const blobResponse = await fetchWithTimeout(
      `https://api.github.com/repos/${owner}/${repo}/git/blobs/${node.sha}`,
      { headers },
      120000,
    );
    if (!blobResponse.ok) throw new Error(`blobs 接口返回 ${blobResponse.status}`);
    const blob = await blobResponse.json();
    return Buffer.from(String(blob.content).replace(/\n/g, ''), 'base64');
  } catch (error) {
    const wrapped = new Error(
      `从 GitHub 取文件失败：${String(error?.message ?? error)}` +
        (firstError ? `（contents: ${firstError}）` : ''),
    );
    wrapped.code = 'DOWNLOAD_FAILED';
    throw wrapped;
  }
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
  } else if (parsed.kind === 'github-file') {
    // parsed.path 是仓库内路径，不是 URL，直接用 basename
    name = String(parsed.path).split('/').filter(Boolean).pop() || 'bundle.zip';
    from = 'github-file';
    report(`从 GitHub 取文件：${parsed.owner}/${parsed.repo}@${parsed.ref ?? 'HEAD'} · ${parsed.path}`);
  } else {
    url = parsed.url;
    name = basenameOf(url) || 'bundle.zip';
    from = 'direct';
    report(`下载直链：${url}`);
  }

  report(`开始下载（${from}）`);
  /* github.com 的 /raw/ 与 /blob/ 链接会跳到被墙的 raw.githubusercontent.com，
   * 所以这类地址改走 api.github.com 取内容。 */
  const data =
    parsed.kind === 'github-file' ? await downloadGithubFile(parsed) : await download(url);
  report(`下载完成：${(data.length / 1048576).toFixed(1)} MiB`);

  // 落到 inbox（保留扩展名，后续按 .zip/.tgz 分流）
  // origin='network'：安装成功后可以自动删掉这份副本，不占用户磁盘
  pruneSafe(home);
  const saved = saveIncomingZip({ home, filename: name, data, origin: 'network' });
  report(`已保存到 ${saved.file}`);

  /* 关键：校验它到底是什么。
   *
   * 三种可能，靠内容判断而不是靠地址猜：
   *   .tgz                      → 单个插件的 npm tarball
   *   .zip 带 manifest.json     → dsh-plugin-pack 整合包
   *   .zip 带 package.json      → 单个插件的原仓库（GitHub 归档常见）
   *   都不是                    → 报「不是整合包也不是插件」
   */
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

  // .zip：先认「链接整合包」，再按整合包认，最后按单插件仓库认
  const linkBundle = readLinkBundle(saved.file);
  if (linkBundle) {
    report(`校验通过：链接整合包（${linkBundle.plugins.length} 个插件，按地址现取）`);
    return {
      file: saved.file,
      bytes: saved.bytes,
      name,
      from,
      kind: 'link-bundle',
      manifest: linkBundle.manifest,
      plugins: linkBundle.plugins.map((plugin) => ({ name: plugin.name, version: plugin.version })),
    };
  }

  try {
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
  } catch (bundleError) {
    /* 不是整合包 → 看看是不是某个插件的原仓库。
     * 判断依据是解出来的目录里有合法 package.json（有 name），
     * 而不是"地址长得像 github"。 */
    report('不是整合包，检查是否为单个插件的原仓库…');
    const detected = await detectPluginInZip(data, path.dirname(saved.file));
    if (detected) {
      report(`校验通过：单个插件 ${detected.info.name}@${detected.info.version ?? '?'}（来自仓库）`);
      return {
        file: saved.file,
        bytes: saved.bytes,
        name,
        from,
        kind: 'plugin',
        dir: detected.dir,
        manifest: null,
        plugins: [{ name: detected.info.name, version: detected.info.version ?? null }],
      };
    }
    throw bundleError;
  }
}

/**
 * 在一个 zip 里找"单个插件"的根目录。
 *
 * GitHub 的仓库归档会多包一层 `<repo>-<ref>/`，所以要判断：
 *   - 根目录就有 package.json → 就是它
 *   - 只有一个顶层目录，且该目录里有 package.json → 用它
 * 其它情况（散落多目录、没有 package.json）返回 null。
 *
 * @param {Buffer} buffer zip 内容
 * @param {string} parentDir 解压到哪儿（会在其下建 extracted/）
 * @returns {Promise<{ dir: string, info: object } | null>}
 */
async function detectPluginInZip(buffer, parentDir) {
  try {
    const entries = readZip(buffer);
    if (!entries.length) return null;

    // 先看有没有 package.json，以及它的层级
    const pkgEntry = entries.find((entry) => entry.name === 'package.json' || /^[^/]+\/package\.json$/.test(entry.name));
    if (!pkgEntry) return null;

    const dest = path.join(parentDir, 'extracted');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });

    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      const target = path.join(dest, entry.name);
      // 防路径穿越
      if (!path.resolve(target).startsWith(path.resolve(dest))) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    }

    // package.json 在根还是在唯一子目录里
    const rootPkg = path.join(dest, 'package.json');
    let pluginDir = dest;
    if (!fs.existsSync(rootPkg)) {
      pluginDir = path.join(dest, path.dirname(pkgEntry.name));
    }

    const { describeLocalPlugin } = await import('./import-plugin.js');
    const info = describeLocalPlugin(pluginDir);
    if (!info?.name) return null;
    return { dir: pluginDir, info };
  } catch {
    return null;
  }
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
    case 'github-file':
      return `GitHub 文件 ${parsed.owner}/${parsed.repo} · ${parsed.path}`;
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
