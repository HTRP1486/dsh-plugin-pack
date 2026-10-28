/**
 * 宿主 HTTP 桥接：给客户端界面提供 /plugin-pack/* 接口。
 *
 * 客户端（桌面端或 Web GUI）通过 fetch 调这些路由，界面只负责展示与触发，
 * 真正的文件操作全部在宿主侧完成（客户端拿不到文件系统）。
 *
 * 路由：
 *   GET  /plugin-pack/status          当前 profile、插件清单、备份列表、配置
 *   POST /plugin-pack/export          导出（body: { out?, include?, exclude?, includeData?, includeSecrets?, dryRun? }）
 *   POST /plugin-pack/inspect         读包（body: { file }）
 *   POST /plugin-pack/import          导入（body: { file, dryRun?, mode?, restoreData?, linkNodeModules?, only? }）
 *   POST /plugin-pack/rollback        回滚（body: { backup? }）
 *   POST /plugin-pack/browse          列目录，给界面做文件选择器（body: { dir }）
 *   POST /plugin-pack/hotload         热加载某个插件的客户端界面（body: { package?, dir? }）
 *   GET  /plugin-pack/client          查客户端图表状态（?package=）
 *   GET  /plugin-pack/config          读插件配置
 *   POST /plugin-pack/config          写插件配置
 *
 * @module dsh-plugin-pack/server
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanProfile } from './scan.js';
import { exportBundle } from './export.js';
import { importBundle, inspectBundle, rollbackImport, listBackups } from './import.js';
import { reloadClientPackage, clientStatus, localVerdict } from '../hotload.js';
import { importLocalPlugin } from './import-plugin.js';
import { importTarball, isTarball } from './import-tgz.js';
import { parseMultipart, boundaryOf, saveIncomingZip, saveIncomingDir, pruneInbox } from './inbox.js';
import { runJob, listJobs, getJob, runningJobs, clearFinished } from './jobs.js';
import { dshHome as resolveDshHome, profileDir as resolveProfileDir, profileName as resolveProfileName, humanBytes } from './home.js';
import { readJson, writeJson, isDir, isFile } from './util.js';

const PREFIX = '/plugin-pack';

/** 读 JSON body，带体积上限。 */
async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error(`请求体过大: ${size} > ${maxBytes}`);
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('请求体必须是 JSON 对象');
      error.status = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.status) throw error;
    const wrapped = new Error(`JSON 解析失败: ${error?.message ?? error}`);
    wrapped.status = 400;
    throw wrapped;
  }
}

/** 统一 JSON 响应。 */
function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** 把异常翻译成 HTTP 状态；其余仍是 500。 */
function statusOf(error) {
  const explicit = Number(error?.status ?? error?.statusCode);
  if (Number.isFinite(explicit) && explicit >= 400 && explicit < 600) return explicit;
  const code = String(error?.code ?? '');
  if (code === 'NOT_FOUND') return 404;
  if (
    code === 'BAD_PACK' ||
    code === 'BAD_MANIFEST' ||
    code === 'BAD_FORMAT' ||
    code === 'BAD_BACKUP' ||
    // "这不是整合包" 归为 400：是用户拖错文件，不是服务端故障
    code === 'NOT_A_ZIP' ||
    code === 'NOT_A_BUNDLE' ||
    code === 'BAD_PLUGIN'
  ) {
    return 400;
  }
  if (code === 'TOO_LARGE') return 413;
  if (code === 'ALREADY_DONE' || code === 'EMPTY_SELECTION' || code === 'NO_PLUGINS') return 409;
  return 500;
}

/** 同源校验：拒绝跨站请求，避免网页面板被别人利用。 */
function sameOrigin(request) {
  const site = String(request?.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return false;
  const origin = String(request?.headers?.origin ?? '').trim();
  if (!origin || origin === 'null') return origin === '' ? true : false;
  try {
    const parsed = new URL(origin);
    const host = String(request?.headers?.host ?? '');
    return parsed.host === host;
  } catch {
    return false;
  }
}

/** 当前环境上下文。 */
function contextOf(config) {
  return {
    home: resolveDshHome(),
    profileDir: resolveProfileDir(),
    profileName: resolveProfileName(),
    config,
  };
}

/** 按包名找包目录。 */
function packageDirOf(packageName, local) {
  const segments = String(packageName).split('/');
  const candidates = [
    path.join(local.profileDir, 'node_modules', ...segments),
    path.join(local.profileDir, 'local-plugins', ...segments),
  ];
  for (const candidate of candidates) {
    try {
      if (isFile(path.join(candidate, 'package.json'))) return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/** 插件自己的偏好文件（写在 $DSH_HOME 下，跨 profile 共享）。 */
function settingsFile(home) {
  return path.join(home, 'plugin-pack', 'settings.json');
}

/** 读插件偏好。 */
export function readSettings(home = resolveDshHome()) {
  return readJson(settingsFile(home), {}) ?? {};
}

/** 写插件偏好。 */
export function writeSettings(home, patch) {
  const next = { ...readSettings(home), ...(patch ?? {}) };
  writeJson(settingsFile(home), next);
  return next;
}

/**
 * 生成状态快照（界面首屏就靠这一个接口）。
 *
 * @param {object} [config]
 * @returns {Promise<object>}
 */
export async function snapshot(config = {}) {
  const ctx = contextOf(config);
  const scan = await scanProfile({
    includeData: Boolean(config.includeData),
    includeSecrets: Boolean(config.includeSecrets),
  });
  const backups = listBackups(ctx.profileDir);
  const settings = readSettings(ctx.home);
  const exportsDir = config.exportDir || path.join(ctx.home, 'exports');
  let recent = [];
  try {
    recent = fs
      .readdirSync(exportsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
      .map((entry) => {
        const full = path.join(exportsDir, entry.name);
        let size = 0;
        let mtime = 0;
        try {
          const stat = fs.statSync(full);
          size = stat.size;
          mtime = stat.mtimeMs;
        } catch {
          /* 读不到就显示 0 */
        }
        return { name: entry.name, path: full, bytes: size, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);
  } catch {
    recent = [];
  }

  return {
    ok: true,
    profile: {
      name: scan.profile.name,
      dir: scan.profile.dir,
      dshHome: scan.profile.dshHome,
      patchFile: scan.profile.patchFile,
    },
    exportsDir,
    plugins: scan.plugins.map((plugin) => ({
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      kind: plugin.kind,
      inBundles: plugin.inBundles,
      sources: plugin.sources,
      deps: plugin.deps.length,
      depBytes: plugin.deps.reduce((sum, dep) => sum + dep.bytes, 0),
      patchRows: plugin.patchRows.length,
      insertRows: plugin.insertRows.length,
      dataCandidates: plugin.dataCandidates,
      bytes: plugin.bytes,
      files: plugin.fileCount,
      bytesText: humanBytes(plugin.bytes),
      warnings: plugin.warnings,
      skipped: plugin.skipped ?? null,
      entry: plugin.entry,
      hasPatch: plugin.hasPatch,
    })),
    totals: {
      plugins: scan.selected.length,
      bytes: scan.totals.bytes,
      files: scan.totals.files,
      bytesText: humanBytes(scan.totals.bytes),
    },
    backups: backups.map((item) => ({
      name: item.name,
      createdAt: item.createdAt,
      source: item.source,
      plugins: item.plugins,
    })),
    recentExports: recent,
    settings: {
      exportDir: exportsDir,
      includeData: Boolean(config.includeData),
      includeSecrets: Boolean(config.includeSecrets),
      maxBytes: config.maxBytes ?? 512 * 1024 * 1024,
      defaultOut: settings.defaultOut ?? '',
      ...settings,
    },
    warnings: scan.warnings,
  };
}

/**
 * 列目录（界面上的文件选择器用）。
 *
 * 比普通选择器多做三件事，都是为了让"找路径"不那么费劲：
 *   - 返回面包屑（ancestors），点哪一级跳哪一级，不用一级一级往上按
 *   - 返回盘符根（roots），Windows 上能直接从 C:\ D:\ 起步
 *   - 同时返回子目录和 .zip，一次目录走完（mode 参数只是排序偏好）
 *
 * 关于"不存在的目录"：
 *   默认**不创建**、直接报错——否则用户粘错一个路径，磁盘上会多出一堆空目录。
 *   只有 `create: true`（导出目标目录）才创建。
 *
 * @param {string} [dir]
 * @param {{ create?: boolean }} [options]
 * @returns {object}
 */
export function browse(dir, options = {}) {
  const create = Boolean(options.create);
  const roots = listRoots();
  let target = dir && String(dir).trim() ? path.resolve(String(dir).trim()) : roots[0] ?? process.cwd();

  // 用户可能直接粘了一个文件路径：自动跳到它的目录，并把该文件选中
  let selectFile = null;
  try {
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      selectFile = target;
      target = path.dirname(target);
    }
  } catch {
    /* 不存在，下面再处理 */
  }

  if (!isDir(target)) {
    if (!create) {
      const error = new Error(`路径不存在: ${target}`);
      error.code = 'NOT_FOUND';
      throw error;
    }
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      const error = new Error(`目录不存在且无法创建: ${target}`);
      error.code = 'NOT_FOUND';
      throw error;
    }
  }

  // 面包屑：从盘符根一路到当前目录
  const ancestors = [];
  {
    let cursor = target;
    for (let i = 0; i < 64; i += 1) {
      ancestors.unshift({ name: path.basename(cursor) || cursor, path: cursor });
      const up = path.dirname(cursor);
      if (up === cursor) break;
      cursor = up;
    }
  }
  // 大小写统一：面包屑与 dir 都换成真实大小写，否则界面上会一段大写一段小写
  const realDir = realOrSelf(target);
  for (const crumb of ancestors) crumb.path = realOrSelf(crumb.path);

  const items = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(target, entry.name);
    let isDirectory = entry.isDirectory();
    let size = 0;
    if (entry.isSymbolicLink()) {
      try {
        const stat = fs.statSync(full);
        isDirectory = stat.isDirectory();
        size = stat.size;
      } catch {
        continue;
      }
    } else if (entry.isFile()) {
      try {
        size = fs.statSync(full).size;
      } catch {
        size = 0;
      }
    }
    if (isDirectory) {
      items.push({ name: entry.name, path: full, dir: true, size: 0 });
      continue;
    }
    // 目录里只列 .zip 和其他可能有用的单文件，避免一屏几百个无关文件
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.tgz') || lower.endsWith('.tar.gz')) {
      items.push({ name: entry.name, path: full, dir: false, size });
    }
  }
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

  return {
    ok: true,
    // 传真实大小写：用户粘 'D:\TEMP\X' 时，界面显示和后续比较都应该用它实际的名字
    dir: realDir,
    parent: path.dirname(target) === target ? null : realOrSelf(path.dirname(target)),
    ancestors,
    roots,
    items,
    selectFile,
  };
}

/** 取真实大小写的路径；失败时退回原值（大写在 Windows 上不敏感，但显示要一致）。 */
function realOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  }
}

/** 可用的盘符 / 根目录（Windows 上遍历 A-Z，其他平台返回 / 与 home）。 */
export function listRoots() {
  if (process.platform !== 'win32') {
    const list = [{ name: '/', path: '/' }];
    try {
      list.push({ name: 'home', path: os.homedir() });
    } catch {
      /* 忽略 */
    }
    return list;
  }
  const roots = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    try {
      fs.accessSync(drive);
      roots.push({ name: drive, path: drive });
    } catch {
      /* 该盘不存在 */
    }
  }
  return roots;
}

/**
 * 把路由挂到宿主的 webServer 上。
 *
 * @param {object} ctx cordis 上下文（需要 webServer 服务）
 * @param {object} config 插件配置
 */
export function mountRoutes(ctx, config = {}) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = [];
      const register = (spec, label) => {
        const dispose = host.webServer.register(
          {
            ...spec,
            handler: async (request, response) => {
              if (!sameOrigin(request)) {
                sendJson(response, 403, { ok: false, error: 'cross-origin blocked' });
                return;
              }
              try {
                return await spec.handler(request, response);
              } catch (error) {
                sendJson(response, statusOf(error), { ok: false, error: String(error?.message ?? error), code: error?.code });
              }
            },
          },
          label,
        );
        if (typeof dispose === 'function') disposers.push(dispose);
        return dispose;
      };

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/status`,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              sendJson(response, 405, { ok: false, error: '只支持 GET' });
              return;
            }
            sendJson(response, 200, await snapshot(config));
          },
        },
        'plugin-pack: status',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/export`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            const ctx2 = contextOf(config);
            const dryRun = Boolean(body.dryRun);
            const include = Array.isArray(body.include) && body.include.length ? body.include : null;

            const doExport = (report) =>
              exportBundle({
                out: body.out || config.exportDir || path.join(ctx2.home, 'exports'),
                include,
                exclude: Array.isArray(body.exclude) ? body.exclude : [],
                includeData: Boolean(body.includeData) || Boolean(config.includeData),
                includeSecrets: Boolean(body.includeSecrets) || Boolean(config.includeSecrets),
                maxBytes: Number(body.maxBytes) || config.maxBytes,
                dryRun,
                onProgress: report,
              });

            // dryRun 很快，不当后台任务；真实导出登记成任务，切走画面也能查结果
            if (dryRun) {
              const result = await doExport(() => {});
              sendJson(response, 200, {
                ok: true,
                file: result.file,
                bytes: result.bytes,
                rawBytes: result.rawBytes,
                entries: result.entries,
                dryRun: true,
                plugins: result.plugins,
                warnings: result.warnings,
              });
              return;
            }

            const title = include
              ? `导出 ${include.length} 个插件`
              : `导出全部插件`;
            const { id, result } = await runJob({
              kind: 'export',
              title,
              meta: { include, out: body.out ?? null },
              task: (report) => doExport(report),
            });
            sendJson(response, 200, {
              ok: true,
              jobId: id,
              file: result.file,
              bytes: result.bytes,
              rawBytes: result.rawBytes,
              entries: result.entries,
              kind: result.kind,
              dryRun: false,
              plugins: result.plugins,
              warnings: result.warnings,
            });
          },
        },
        'plugin-pack: export',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/inspect`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            if (!body.file) {
              sendJson(response, 400, { ok: false, error: '需要 file' });
              return;
            }
            const info = inspectBundle(body.file);
            sendJson(response, 200, {
              ok: true,
              file: info.file,
              bytes: info.bytes,
              createdAt: info.createdAt,
              source: info.source,
              entryCount: info.entryCount,
              plugins: info.plugins.map(({ manifest, ...rest }) => rest),
              warnings: info.warnings,
            });
          },
        },
        'plugin-pack: inspect',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/import`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            if (!body.file) {
              sendJson(response, 400, { ok: false, error: '需要 file' });
              return;
            }
            // 按扩展名分流：.tgz/.tar.gz 是单插件的 npm tarball，其余按整合包 zip 处理
            if (isTarball(body.file)) {
              const local = contextOf(config);
              const dryRun = Boolean(body.dryRun);
              const doImport = (report) =>
                importTarball({
                  file: body.file,
                  home: local.home,
                  profileDir: local.profileDir,
                  dryRun,
                  mode: body.mode === 'skip' ? 'skip' : 'merge',
                  decisions: body.decisions && typeof body.decisions === 'object' ? body.decisions : {},
                  onProgress: report,
                });
              if (dryRun) {
                sendJson(response, 200, doImport(() => {}));
                return;
              }
              const { id, result } = await runJob({
                kind: 'import',
                title: `导入单个插件（tgz）`,
                meta: { file: body.file },
                task: (report) => doImport(report),
              });
              sendJson(response, 200, { ...result, jobId: id });
              return;
            }
            const dryRun = Boolean(body.dryRun);
            const doImportBundle = (report) =>
              importBundle({
                file: body.file,
                dryRun,
                mode: body.mode === 'skip' ? 'skip' : 'merge',
                overwritePatchConfig: Boolean(body.overwritePatchConfig) || Boolean(config.overwritePatchConfig),
                restoreData: body.restoreData !== false,
                linkNodeModules: body.linkNodeModules !== false,
                only: Array.isArray(body.only) && body.only.length ? body.only : null,
                // 逐插件决策：界面弹窗后传进来，优先级高于全局 mode
                decisions: body.decisions && typeof body.decisions === 'object' ? body.decisions : {},
                onProgress: report,
              });
            if (dryRun) {
              sendJson(response, 200, doImportBundle(() => {}));
              return;
            }
            const { id, result } = await runJob({
              kind: 'import',
              title: `导入整合包`,
              meta: { file: body.file },
              task: (report) => doImportBundle(report),
            });
            sendJson(response, 200, { ...result, jobId: id });
          },
        },
        'plugin-pack: import',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/rollback`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            const { id, result } = await runJob({
              kind: 'rollback',
              title: `回滚 ${body.backup ?? '(最新备份)'}`,
              meta: { backup: body.backup ?? null },
              task: () => rollbackImport({ backup: body.backup }),
            });
            sendJson(response, 200, { ...result, jobId: id });
          },
        },
        'plugin-pack: rollback',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/browse`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            // 选目录（导出目标）时才允许自动创建；找 zip 时不创建，免得粘错路径造出空目录
            sendJson(response, 200, browse(body.dir, { create: body.create === true }));
          },
        },
        'plugin-pack: browse',
      );

      /* 拖放上传：浏览器拿不到绝对路径，只能把内容传上来，宿主落盘后再走导入流程。
       * 用 multipart 而不是 base64 JSON —— 几百 MB 的包 base64 会膨胀 33%。 */
      register(
        {
          kind: 'exact',
          path: `${PREFIX}/upload-zip`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const boundary = boundaryOf(request.headers?.['content-type']);
            if (!boundary) {
              sendJson(response, 400, { ok: false, error: '缺少 multipart boundary' });
              return;
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 1024 * 1024 * 1024) {
                sendJson(response, 413, { ok: false, error: '文件超过 1 GiB' });
                return;
              }
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const parts = parseMultipart(Buffer.concat(chunks), boundary);
            const filePart = parts.find((part) => part.filename);
            if (!filePart) {
              sendJson(response, 400, { ok: false, error: '请求里没有文件' });
              return;
            }
            const home = resolveDshHome();
            pruneInbox(home);
            const saved = saveIncomingZip({ home, filename: filePart.filename, data: filePart.data });
            sendJson(response, 200, { ok: true, ...saved, filename: filePart.filename });
          },
        },
        'plugin-pack: upload-zip',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/upload-dir`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const boundary = boundaryOf(request.headers?.['content-type']);
            if (!boundary) {
              sendJson(response, 400, { ok: false, error: '缺少 multipart boundary' });
              return;
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 1024 * 1024 * 1024) {
                sendJson(response, 413, { ok: false, error: '目录超过 1 GiB' });
                return;
              }
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const parts = parseMultipart(Buffer.concat(chunks), boundary);
            // 每个 part 的 name 是相对路径（如 "my-plugin/lib/index.js"）
            const files = parts
              .filter((part) => part.filename !== null && part.name)
              .map((part) => ({ rel: part.name, data: part.data }));
            if (!files.length) {
              sendJson(response, 400, { ok: false, error: '请求里没有文件' });
              return;
            }
            const rootName = String(parts[0]?.name ?? '').split('/')[0] || 'plugin';
            const home = resolveDshHome();
            pruneInbox(home);
            const saved = saveIncomingDir({ home, rootName, files });
            sendJson(response, 200, { ok: true, ...saved, rootName });
          },
        },
        'plugin-pack: upload-dir',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/hotload`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            const packageName = String(body.package ?? '').trim() || 'dsh-plugin-pack';
            const config2 = config;
            const ctx2 = contextOf(config2);
            const packageDir = String(body.dir ?? '').trim() || packageDirOf(packageName, ctx2);
            if (!packageDir) {
              sendJson(response, 404, { ok: false, error: `找不到包目录: ${packageName}` });
              return;
            }
            const verdict = localVerdict(packageDir);
            const steps = [];
            const result = reloadClientPackage(ctx, {
              packageName,
              packageDir,
              log: (message) => steps.push(message),
            });
            sendJson(response, 200, {
              ok: result.ok,
              package: packageName,
              dir: packageDir,
              verdict,
              rev: result.rev,
              inTable: result.inTable,
              clearedCaches: result.clearedCaches,
              steps,
              failures: result.failures,
              error: result.error,
              note: result.ok ? '刷新页面（Ctrl+F5）即可看到界面' : undefined,
            });
          },
        },
        'plugin-pack: hotload',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/client`,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              sendJson(response, 405, { ok: false, error: '只支持 GET' });
              return;
            }
            const url = new URL(request.url ?? '/', 'http://localhost');
            const packageName = url.searchParams.get('package') || 'dsh-plugin-pack';
            const status = clientStatus(ctx, packageName);
            sendJson(response, 200, { ok: true, package: packageName, ...status });
          },
        },
        'plugin-pack: client',
      );

      /* 后台任务：切走画面再回来，靠这个接口把进度和结果捡回来。
       *   GET  /plugin-pack/jobs           列出任务（含进行中、已完成）
       *   GET  /plugin-pack/jobs?id=37a1159f  查单个（id 是任务返回的那个）
       *   POST /plugin-pack/jobs/clear     清空已完成记录 */
      register(
        {
          kind: 'exact',
          path: `${PREFIX}/jobs`,
          handler: async (request, response) => {
            if (request.method !== 'GET') {
              sendJson(response, 405, { ok: false, error: '只支持 GET' });
              return;
            }
            const url = new URL(request.url ?? '/', 'http://localhost');
            const id = url.searchParams.get('id');
            if (id) {
              const job = getJob(id);
              if (!job) {
                sendJson(response, 404, { ok: false, error: `没有这个任务: ${id}` });
                return;
              }
              sendJson(response, 200, { ok: true, job });
              return;
            }
            const limit = Number(url.searchParams.get('limit')) || 20;
            sendJson(response, 200, {
              ok: true,
              jobs: listJobs({ limit }),
              running: runningJobs(),
            });
          },
        },
        'plugin-pack: jobs',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/jobs/clear`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            sendJson(response, 200, { ok: true, removed: clearFinished() });
          },
        },
        'plugin-pack: jobs-clear',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/import-plugin`,
          handler: async (request, response) => {
            if (request.method !== 'POST') {
              sendJson(response, 405, { ok: false, error: '只支持 POST' });
              return;
            }
            const body = await readJsonBody(request);
            if (!body.dir) {
              sendJson(response, 400, { ok: false, error: '需要 dir（插件目录）' });
              return;
            }
            const local = contextOf(config);
            const dryRun = Boolean(body.dryRun);
            const doImport = (report) =>
              importLocalPlugin({
                dir: body.dir,
                profileDir: local.profileDir,
                dryRun,
                mode: body.mode === 'skip' ? 'skip' : 'merge',
                linkNodeModules: body.linkNodeModules !== false,
                decisions: body.decisions && typeof body.decisions === 'object' ? body.decisions : {},
                onProgress: report,
              });
            if (dryRun) {
              sendJson(response, 200, doImport(() => {}));
              return;
            }
            const { id, result } = await runJob({
              kind: 'import-plugin',
              title: `导入本地插件`,
              meta: { dir: body.dir },
              task: (report) => doImport(report),
            });
            sendJson(response, 200, { ...result, jobId: id });
          },
        },
        'plugin-pack: import-plugin',
      );

      register(
        {
          kind: 'exact',
          path: `${PREFIX}/config`,
          handler: async (request, response) => {
            const home = resolveDshHome();
            if (request.method === 'GET') {
              sendJson(response, 200, { ok: true, settings: readSettings(home) });
              return;
            }
            if (request.method === 'POST') {
              const body = await readJsonBody(request);
              const saved = writeSettings(home, body);
              sendJson(response, 200, { ok: true, settings: saved, note: '重启 dsh 后对导出默认值生效' });
              return;
            }
            sendJson(response, 405, { ok: false, error: '只支持 GET / POST' });
          },
        },
        'plugin-pack: config',
      );

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 单条撤销失败不影响其它 */
          }
        }
      };
    }, 'plugin-pack: http routes');
  });
}
