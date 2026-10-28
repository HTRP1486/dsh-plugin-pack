/**
 * dsh-plugin-pack 入口：注册 5 个工具 + /pack 命令。
 *
 * 所有能力都在本文件里组装，子模块只做纯函数/文件操作，方便单测和 CLI 复用。
 *
 * @module dsh-plugin-pack
 */
import fs from 'node:fs';
import path from 'node:path';

import { scanProfile } from './scan.js';
import { exportBundle, resolveOutFile } from './export.js';
import { importBundle, inspectBundle, rollbackImport, listBackups } from './import.js';
import { mountRoutes } from './server.js';
import { reloadClientPackage, clientStatus, localVerdict } from '../hotload.js';
import { dshHome as resolveDshHome, profileDir as resolveProfileDir, profileName as resolveProfileName, humanBytes } from './home.js';
import { isFile } from './util.js';

export const name = 'dsh-plugin-pack';
export const inject = ['tools'];

/** 本包所在目录（判断 Loader 行是否属于自己）。 */
const SELF_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

export const DEFAULTS = {
  enabled: true,
  exportDir: '',
  includeData: false,
  includeSecrets: false,
  // 按未压缩字节算；压缩比约 1:3，2 GiB 原始 ≈ 600~700 MiB 成品
  maxBytes: 2 * 1024 * 1024 * 1024,
  overwritePatchConfig: false,
  selfHotload: true,
};

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
};

/** 统一错误转文本，工具不抛。 */
function fail(error) {
  const message = error?.message ?? String(error);
  return { text: `ERROR: ${message}` };
}

/** 按包名找包目录：先 current profile 的 node_modules，再本包自己的真实目录。 */
function resolvePackageDirFor(packageName, local) {
  const segments = String(packageName).split('/');
  const candidates = [
    path.join(local.profileDir, 'node_modules', ...segments),
    path.join(local.profileDir, 'local-plugins', ...segments),
    SELF_DIR,
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

/** 当前上下文。 */
function context(config) {
  const env = process.env;
  return {
    env,
    home: resolveDshHome(env),
    profileDir: resolveProfileDir(env),
    profileName: resolveProfileName(env),
    config,
  };
}

/** 宿主 cordis 上下文（给热加载用）。 */
let pluginCtx = null;

/** 渲染插件清单。 */
export function renderList(scan, ctx, backups = []) {
  const lines = [];
  lines.push(`profile: ${scan.profile.name}  (${scan.profile.dir})`);
  lines.push(`DSH_HOME: ${scan.profile.dshHome}`);
  lines.push(`扫到插件 ${scan.plugins.length} 个，可导出 ${scan.selected.length} 个，合计 ${humanBytes(scan.totals.bytes)} / ${scan.totals.files} 文件`);
  lines.push('');
  const header = ['', '插件', '版本', '类型', '依赖', 'patch', '体积', '来源'];
  const rows = scan.plugins.map((plugin, index) => [
    plugin.skipped ? ' ' : '•',
    plugin.name,
    plugin.version,
    plugin.kind,
    `${plugin.deps.length}`,
    `${plugin.patchRows.length}+${plugin.insertRows.length}`,
    humanBytes(plugin.bytes),
    plugin.inBundles ? 'bundles' : plugin.sources.join('/'),
  ]);
  lines.push(renderTable([header, ...rows]));
  const dataCandidates = scan.plugins.filter((plugin) => plugin.dataCandidates.length);
  if (dataCandidates.length) {
    lines.push('');
    lines.push('可选数据目录（默认不打包，导出时加 includeData=true）：');
    for (const plugin of dataCandidates) {
      lines.push(`  - ${plugin.name}: ${plugin.dataCandidates.join(', ')}`);
    }
  }
  if (scan.warnings.length) {
    lines.push('');
    lines.push(`警告 ${scan.warnings.length} 条：`);
    for (const warning of scan.warnings.slice(0, 20)) lines.push(`  ! ${warning}`);
    if (scan.warnings.length > 20) lines.push(`  ... 其余 ${scan.warnings.length - 20} 条略`);
  }
  lines.push('');
  lines.push(`备份目录: ${path.join(ctx.profileDir, '.plugin-backups')}`);
  if (backups.length) {
    lines.push(`可回滚备份 ${backups.length} 个（最新在前）：`);
    for (const backup of backups.slice(0, 5)) {
      lines.push(`  - ${backup.name}  ${backup.createdAt ?? ''}  ${backup.plugins} 项`);
    }
  } else {
    lines.push('还没有导入备份。');
  }
  return lines.join('\n');
}

/** 极简表格对齐（按显示宽度近似，中文算 2）。 */
function renderTable(rows) {
  const width = (text) => [...String(text)].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  const columns = Math.max(...rows.map((row) => row.length));
  const widths = new Array(columns).fill(0);
  for (const row of rows) {
    for (let i = 0; i < columns; i += 1) widths[i] = Math.max(widths[i], width(row[i] ?? ''));
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) => {
          const text = String(cell ?? '');
          return text + ' '.repeat(Math.max(0, widths[index] - width(text)));
        })
        .join('  ')
        .replace(/\s+$/, ''),
    )
    .join('\n');
}

/** 渲染导出结果。 */
export function renderExport(result) {
  const lines = [];
  if (result.dryRun) {
    lines.push(`[dry-run] 将导出 ${result.plugins.length} 个插件到 ${result.file}`);
  } else {
    lines.push(`✓ 整合包已生成: ${result.file}`);
    lines.push(`  体积 ${humanBytes(result.bytes)}（未压缩 ${humanBytes(result.rawBytes)}），${result.entries} 个条目`);
  }
  lines.push('');
  lines.push(renderTable([
    ['插件', '版本', '文件', '体积', '依赖', 'patch'],
    ...result.plugins.map((plugin) => [
      plugin.name,
      plugin.version,
      `${plugin.files}`,
      humanBytes(plugin.bytes),
      `${plugin.deps}`,
      `${plugin.patchRows}+${plugin.insertRows}`,
    ]),
  ]));
  if (result.warnings?.length) {
    lines.push('');
    lines.push(`警告 ${result.warnings.length} 条：`);
    for (const warning of result.warnings.slice(0, 20)) lines.push(`  ! ${warning}`);
  }
  if (!result.dryRun) {
    lines.push('');
    lines.push('在另一台机器/另一个 profile 上导入：');
    lines.push(`  /pack import "${result.file}"`);
  }
  return lines.join('\n');
}

/** 渲染导入结果。 */
export function renderImport(result) {
  const lines = [];
  if (result.dryRun) {
    lines.push(`[dry-run] 准备导入 ${result.plugins.length} 个插件到 ${result.profile}`);
    lines.push(`  模式: ${result.mode}`);
    lines.push('');
    lines.push(renderTable([
      ['插件', '版本', '动作', '文件', '体积', '链接状态'],
      ...result.plugins.map((plugin) => [
        plugin.name,
        plugin.version,
        plugin.action,
        `${plugin.files}`,
        humanBytes(plugin.bytes),
        plugin.linkState,
      ]),
    ]));
    lines.push('');
    lines.push(`patch 将写入: 顶层 ${result.patch.topRows} 条, insert ${result.patch.insertRows} 条`);
    if (result.bundlesToAdd.length) lines.push(`bundles 将新增: ${result.bundlesToAdd.join(', ')}`);
    lines.push('（dry-run 没有写任何文件）');
  } else {
    lines.push(`✓ 导入完成，profile: ${result.profileLabel}`);
    lines.push(`  备份: ${result.backup}`);
    lines.push('');
    lines.push(renderTable([
      ['插件', '动作', '文件'],
      ...result.plugins.map((plugin) => [plugin.name, plugin.action, `${plugin.files ?? ''}`]),
    ]));
    lines.push('');
    lines.push(`patch 写入: 顶层 ${result.patch.topRows} 条, insert ${result.patch.insertRows} 条`);
    if (result.bundlesAdded.length) lines.push(`bundles 新增: ${result.bundlesAdded.join(', ')}`);
    if (result.dataRestored) lines.push(`数据文件还原: ${result.dataRestored} 个`);
    const badLinks = (result.links ?? []).filter((link) => link.status === 'failed');
    if (badLinks.length) {
      lines.push('');
      lines.push(`链接失败 ${badLinks.length} 个（可手动 pnpm install 补齐）：`);
      for (const link of badLinks) lines.push(`  ! ${link.name}: ${link.error}`);
    }
    lines.push('');
    lines.push('**重启 dsh 生效。** 回滚: /pack rollback');
  }
  if (result.warnings?.length) {
    lines.push('');
    lines.push(`警告 ${result.warnings.length} 条：`);
    for (const warning of result.warnings.slice(0, 20)) lines.push(`  ! ${warning}`);
  }
  return lines.join('\n');
}

/** 渲染 inspect。 */
export function renderInspect(info) {
  const lines = [];
  lines.push(`整合包: ${info.file}`);
  lines.push(`体积: ${humanBytes(info.bytes)}  条目: ${info.entryCount}`);
  lines.push(`生成: ${info.createdAt ?? '?'}  来源 profile: ${info.source?.profile ?? '?'}`);
  lines.push(`来源目录: ${info.source?.profileDir ?? '?'}`);
  lines.push('');
  lines.push(renderTable([
    ['插件', '版本', '文件', '体积', '依赖', 'patch', 'package.json'],
    ...info.plugins.map((plugin) => [
      plugin.name,
      plugin.version,
      `${plugin.files}`,
      humanBytes(plugin.bytes),
      `${plugin.deps}`,
      `${plugin.patchRows}+${plugin.insertRows}`,
      plugin.hasPackageJson ? 'ok' : '缺失',
    ]),
  ]));
  if (info.warnings?.length) {
    lines.push('');
    for (const warning of info.warnings.slice(0, 20)) lines.push(`  ! ${warning}`);
  }
  return lines.join('\n');
}

/** 解析 `/pack` 的文本参数。 */
export function parseArgs(rawInput) {
  const tokens = String(rawInput ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const flags = new Map();
  const positional = [];
  for (const token of tokens) {
    if (token.startsWith('--')) {
      const [key, ...rest] = token.slice(2).split('=');
      flags.set(key, rest.length ? rest.join('=') : true);
      continue;
    }
    if (token.startsWith('-') && token.length > 1 && !path.isAbsolute(token)) {
      flags.set(token.slice(1), true);
      continue;
    }
    positional.push(token.replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1'));
  }
  return { positional, flags };
}

/** 处理 /pack 命令。 */
export async function handlePackCommand(rawInput, config) {
  const { positional, flags } = parseArgs(rawInput);
  const sub = (positional[0] ?? 'list').toLowerCase();
  const ctx = context(config);
  try {
    switch (sub) {
      case 'list':
      case 'ls':
      case 'status': {
        const scan = await scanProfile({
          includeData: Boolean(flags.get('data')),
          includeSecrets: Boolean(flags.get('secrets')),
        });
        return { kind: 'success', text: renderList(scan, ctx, listBackups(ctx.profileDir)) };
      }
      case 'export':
      case 'save':
      case 'e': {
        const out = positional[1];
        const include = typeof flags.get('include') === 'string' ? String(flags.get('include')).split(',').map((item) => item.trim()).filter(Boolean) : null;
        const exclude = typeof flags.get('exclude') === 'string' ? String(flags.get('exclude')).split(',').map((item) => item.trim()).filter(Boolean) : [];
        const result = await exportBundle({
          out: out ?? (config.exportDir || path.join(ctx.home, 'exports')),
          include,
          exclude,
          includeData: Boolean(flags.get('data')) || config.includeData,
          includeSecrets: Boolean(flags.get('secrets')) || config.includeSecrets,
          maxBytes: config.maxBytes,
          dryRun: Boolean(flags.get('dry')) || Boolean(flags.get('dry-run')),
        });
        return { kind: 'success', text: renderExport(result) };
      }
      case 'inspect':
      case 'info':
      case 'i': {
        const file = positional[1];
        if (!file) return { kind: 'error', text: '用法: /pack inspect <zip 路径>' };
        return { kind: 'success', text: renderInspect(inspectBundle(file)) };
      }
      case 'import':
      case 'load': {
        const file = positional[1];
        if (!file) return { kind: 'error', text: '用法: /pack import <zip 路径> [--dry] [--skip] [--no-data] [--no-link]' };
        const result = importBundle({
          file,
          dryRun: Boolean(flags.get('dry')) || Boolean(flags.get('dry-run')),
          mode: flags.get('skip') ? 'skip' : 'merge',
          overwritePatchConfig: Boolean(flags.get('overwrite')) || config.overwritePatchConfig,
          restoreData: !flags.get('no-data'),
          linkNodeModules: !flags.get('no-link'),
        });
        return { kind: 'success', text: renderImport(result) };
      }
      case 'rollback':
      case 'undo': {
        const backup = positional[1];
        const result = rollbackImport({ backup });
        return {
          kind: 'success',
          text: `✓ 已回滚到 ${result.backup}\n恢复: ${result.restored.join(', ') || '(无)'}\n删除: ${result.removed.length} 项\n解链: ${result.unlinked.length} 项\n**重启 dsh 生效。**`,
        };
      }
      case 'backups':
      case 'b': {
        const backups = listBackups(ctx.profileDir);
        if (!backups.length) return { kind: 'success', text: '还没有导入备份。' };
        return {
          kind: 'success',
          text: backups.map((item) => `${item.name}  ${item.createdAt ?? ''}  ${item.plugins} 项`).join('\n'),
        };
      }
      case 'hotload':
      case 'reload': {
        const packageName = positional[1] || name;
        const packageDir = resolvePackageDirFor(packageName, ctx);
        if (!packageDir) return { kind: 'error', text: `找不到包目录: ${packageName}` };
        const verdict = localVerdict(packageDir);
        const steps = [];
        const result = reloadClientPackage(pluginCtx, {
          packageName,
          packageDir,
          log: (message) => steps.push(`  · ${message}`),
        });
        return {
          kind: result.ok ? 'success' : 'error',
          text: [
            verdict.ok ? `声明检查: ✓ ${verdict.clientPath}` : `声明检查: ✗ ${verdict.error}`,
            ...steps,
            result.ok ? `✓ 已热加载，rev=${result.rev}。刷新页面（Ctrl+F5）即可。` : `✗ ${result.error}`,
          ].join('\n'),
        };
      }
      case 'client':
      case 'cs': {
        const packageName = positional[1] || name;
        const status = clientStatus(pluginCtx, packageName);
        if (!status.available) return { kind: 'error', text: status.reason };
        return {
          kind: 'success',
          text: [
            `${packageName}: ${status.inTable ? '✓ 在图表里' : '✗ 不在图表里'}`,
            `rev: ${status.rev ?? '(无)'}`,
            `bundle: ${status.clientPath ?? '(无)'}`,
            `图表内 ${status.entries.length} 个包`,
          ].join('\n'),
        };
      }
      case 'help':
      case 'h':
      default:
        return {
          kind: 'success',
          text: [
            'dsh-plugin-pack — 插件整合包一键导出/导入',
            '',
            '/pack list                     列出当前 profile 的第三方插件与备份',
            '/pack export [路径] [选项]     导出整合包',
            '     --include=a,b             只导出这些包',
            '     --exclude=a,b             排除这些包',
            '     --data                    连插件数据目录一起打包',
            '     --secrets                 连 .env / *.pem 一起打包（默认剔除）',
            '     --dry                     只算体积，不写文件',
            '/pack inspect <zip>            看包里有什么',
            '/pack import <zip> [选项]      导入',
            '     --dry                     预演，不写任何文件',
            '     --skip                    目标已存在就跳过',
            '     --no-data                 不还原数据目录',
            '     --no-link                 不建 node_modules 链接',
            '     --overwrite               覆盖同 id 的 patch 行',
            '/pack rollback [备份名]        回滚最近一次导入',
            '/pack backups                  列出备份',
            '',
            `默认导出目录: ${path.join(ctx.home, 'exports')}`,
          ].join('\n'),
        };
    }
  } catch (error) {
    return { kind: 'error', text: `ERROR: ${error?.message ?? error}` };
  }
}

/** cordis 插件入口。 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (!cfg.enabled) return;

  pluginCtx = ctx;

  /* 启动时自己热加载一次客户端半身。
   * 宿主把"这个包不是客户端包"的判定缓存到重启，而我们经常是在装好之后才补
   * exports/plugins.row.config 的 —— 自愈一次比让用户重启强。
   * 失败不阻断启动：热加载只是优化，服务端工具不受影响。 */
  if (cfg.selfHotload !== false) {
    try {
      const delayed = setTimeout(() => {
        try {
          const verdict = localVerdict(SELF_DIR);
          if (!verdict.ok) {
            console.warn(`[dsh-plugin-pack] 客户端声明不完整，跳过自热加载: ${verdict.error}`);
            return;
          }
          const state = clientStatus(ctx, name);
          if (state.available && state.inTable) return;
          const result = reloadClientPackage(ctx, { packageName: name, packageDir: SELF_DIR });
          if (result.ok) console.log(`[dsh-plugin-pack] 客户端半身已热加载 rev=${result.rev}`);
          else console.warn(`[dsh-plugin-pack] 自热加载未成功: ${result.error}`);
        } catch (error) {
          console.warn('[dsh-plugin-pack] 自热加载异常:', String(error?.message ?? error));
        }
      }, 1200);
      delayed.unref?.();
      ctx.effect(() => () => clearTimeout(delayed), 'dsh-plugin-pack: self hotload');
    } catch {
      /* 没有 effect 的上下文：跳过 */
    }
  }

  // 客户端界面用的 HTTP 桥。
  try {
    mountRoutes(ctx, cfg);
  } catch (error) {
    console.warn('[dsh-plugin-pack] 路由挂载失败:', String(error?.message ?? error));
  }

  const commands = ctx.get?.('commands');
  if (commands?.register) {
    commands.register({
      name: 'pack',
      description: '插件整合包：一键导出/导入当前 profile 的全部第三方插件（list/export/inspect/import/rollback）',
      input: { hint: 'list | export [路径] | inspect <zip> | import <zip> | rollback | backups | help' },
      handler: async (invocation) => handlePackCommand(invocation?.rawInput ?? '', cfg),
    });
  }

  if (!ctx.tools) return;

  ctx.tools.register({
    name: 'plugin_pack_list',
    description:
      '列出当前 dsh profile 里所有可导出的第三方插件（含依赖数、patch 行数、体积）、可选的数据目录，以及历史导入备份。做整合包之前先调这个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeData: { type: 'boolean', description: '是否把插件数据目录也算进体积，默认 false' },
        includeSecrets: { type: 'boolean', description: '是否把 .env / *.pem 等凭证文件也算进去，默认 false' },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const local = context(cfg);
        const scan = await scanProfile({
          includeData: Boolean(args?.includeData),
          includeSecrets: Boolean(args?.includeSecrets),
        });
        return { text: renderList(scan, local, listBackups(local.profileDir)) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: 'plugin_pack_export',
    description:
      '把当前 profile 的第三方插件连运行时依赖一键打成 zip 整合包（默认写到 $DSH_HOME/exports）。包内自带 manifest.json，可在另一台机器/另一个 profile 用 plugin_pack_import 还原。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        out: { type: 'string', description: '输出 zip 路径；给目录则自动命名；留空用 $DSH_HOME/exports' },
        include: { type: 'array', items: { type: 'string' }, description: '只导出这些包名' },
        exclude: { type: 'array', items: { type: 'string' }, description: '排除这些包名' },
        includeData: { type: 'boolean', description: '连插件数据目录（$DSH_HOME/<插件名>）一起打包，默认 false' },
        includeSecrets: { type: 'boolean', description: '连 .env / *.pem / credentials.json 一起打包，默认 false' },
        maxBytes: { type: 'number', description: '体积上限，默认 536870912（512 MiB）' },
        dryRun: { type: 'boolean', description: '只统计体积，不写文件' },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const local = context(cfg);
        const result = await exportBundle({
          out: args?.out || cfg.exportDir || path.join(local.home, 'exports'),
          include: Array.isArray(args?.include) ? args.include : null,
          exclude: Array.isArray(args?.exclude) ? args.exclude : [],
          includeData: Boolean(args?.includeData) || cfg.includeData,
          includeSecrets: Boolean(args?.includeSecrets) || cfg.includeSecrets,
          maxBytes: Number(args?.maxBytes) || cfg.maxBytes,
          dryRun: Boolean(args?.dryRun),
        });
        return { text: renderExport(result) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: 'plugin_pack_inspect',
    description: '读取一个整合包 zip 的 manifest，列出里面的插件、版本、体积、依赖数、patch 行，以及包本身的警告。导入前先看这个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '整合包 zip 路径' },
      },
      required: ['file'],
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const file = args?.file;
        if (!file) return { text: 'ERROR: 需要 file 参数（zip 路径）' };
        return { text: renderInspect(inspectBundle(file)) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: 'plugin_pack_import',
    description:
      '导入一个插件整合包：备份现有 package.json / cordis.patch.yml，把插件落到 profile/local-plugins，合并 bundles 与 patch 行，并建立 node_modules 链接。导入后需要重启 dsh。先跑 dryRun 看计划。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: '整合包 zip 路径' },
        dryRun: { type: 'boolean', description: '只返回计划，不写任何文件' },
        mode: { type: 'string', enum: ['merge', 'skip'], description: '目标已存在时覆盖还是跳过，默认 merge' },
        overwritePatchConfig: { type: 'boolean', description: '同 id 的 patch 行是否覆盖，默认 false' },
        restoreData: { type: 'boolean', description: '是否还原包里的数据目录，默认 true' },
        linkNodeModules: { type: 'boolean', description: '是否建立 node_modules 链接，默认 true' },
        only: { type: 'array', items: { type: 'string' }, description: '只导入这些包名' },
      },
      required: ['file'],
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const file = args?.file;
        if (!file) return { text: 'ERROR: 需要 file 参数（zip 路径）' };
        const result = importBundle({
          file,
          dryRun: Boolean(args?.dryRun),
          mode: args?.mode === 'skip' ? 'skip' : 'merge',
          overwritePatchConfig: Boolean(args?.overwritePatchConfig) || cfg.overwritePatchConfig,
          restoreData: args?.restoreData !== false,
          linkNodeModules: args?.linkNodeModules !== false,
          only: Array.isArray(args?.only) ? args.only : null,
        });
        return { text: renderImport(result) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: 'plugin_pack_rollback',
    description: '回滚最近一次（或指定一次）plugin_pack_import：恢复 package.json、cordis.patch.yml、被覆盖的插件目录，删掉本次新增的插件与链接。回滚后需要重启 dsh。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        backup: { type: 'string', description: '备份目录名（如 plugin-pack-20261026-145723）或绝对路径；留空回滚最新一次' },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const result = rollbackImport({ backup: args?.backup });
        return {
          text: [
            `✓ 已回滚到 ${result.backup}`,
            `恢复: ${result.restored.join(', ') || '(无)'}`,
            `删除: ${result.removed.length} 项`,
            `解链: ${result.unlinked.length} 项`,
            '**重启 dsh 生效。**',
          ].join('\n'),
        };
      } catch (error) {
        return fail(error);
      }
    },
  });

  /* 热加载：不用重启就让客户端界面生效。
   * 原理见 ../hotload.js 的注释：宿主把"不是客户端包"的判定缓存在 pkgMeta 里，
   * 清掉缓存 + 标记 dirty + flush，就能让它重扫当前磁盘上的 package.json。 */
  ctx.tools.register({
    name: 'plugin_pack_hotload',
    description:
      '不重启 dsh，让插件的客户端界面立即生效：清掉宿主对"这个包不是客户端包"的缓存，强制重扫 package.json 与 client bundle，并通过 rebuilt 把新 rev 推给浏览器。改完 client.js 或 package.json 后调它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        package: { type: 'string', description: '包名，默认 dsh-plugin-pack 自己；也可以传别的插件包名' },
        dir: { type: 'string', description: '包目录绝对路径；省略时按 profile 的 node_modules 解析' },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const local = context(cfg);
        const packageName = args?.package?.trim() || name;
        const packageDir = args?.dir?.trim() || resolvePackageDirFor(packageName, local);
        if (!packageDir) return { text: `ERROR: 找不到包目录: ${packageName}` };

        const verdict = localVerdict(packageDir);
        const lines = [];
        lines.push(`包: ${packageName}`);
        lines.push(`目录: ${packageDir}`);
        lines.push(
          verdict.ok
            ? `声明检查: ✓ platform=web, client=${verdict.clientPath} (${verdict.bytes} B)`
            : `声明检查: ✗ ${verdict.error}`,
        );

        const result = reloadClientPackage(ctx, {
          packageName,
          packageDir,
          log: (message) => lines.push(`  · ${message}`),
        });
        lines.push('');
        lines.push(result.ok ? `✓ 已进入客户端图表，rev=${result.rev}` : `✗ ${result.error}`);
        if (result.failures?.length) {
          lines.push(`宿主报错 ${result.failures.length} 条:`);
          for (const failure of result.failures.slice(0, 6)) lines.push(`  ! ${failure}`);
        }
        lines.push('');
        lines.push('浏览器端：刷新页面（Ctrl+F5）即可看到界面，不必重启 dsh。');
        return { text: lines.join('\n') };
      } catch (error) {
        return fail(error);
      }
    },
  });

  ctx.tools.register({
    name: 'plugin_pack_client_status',
    description: '查一个插件的客户端界面在宿主图表里的状态：是否已入表、rev、bundle 路径、inject、以及是否在 bootstrap 批次里。排查"插件装上了但界面不显示"时先调这个。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        package: { type: 'string', description: '包名，默认 dsh-plugin-pack 自己' },
      },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      try {
        const packageName = args?.package?.trim() || name;
        const status = clientStatus(ctx, packageName);
        if (!status.available) return { text: `ERROR: ${status.reason}` };
        const lines = [
          `包: ${packageName}`,
          `在图表里: ${status.inTable ? '✓ 是' : '✗ 否'}`,
          `rev: ${status.rev ?? '(无)'}`,
          `client bundle: ${status.clientPath ?? '(无)'}`,
          `inject: ${Array.isArray(status.inject) ? status.inject.join(', ') || '(空)' : '(无)'}`,
          `immediately: ${status.immediately === true ? 'true' : 'false'}`,
        ];
        if (status.inTable && !status.bootstrapIds.includes(packageName)) {
          lines.push('注: 不在 bootstrap 批次里，界面会按需加载（首次进入相关页面时才拉取）。');
        }
        lines.push('');
        lines.push(`图表内全部包 (${status.entries.length}): ${status.entries.join(', ')}`);
        return { text: lines.join('\n') };
      } catch (error) {
        return fail(error);
      }
    },
  });
}

export default { name, inject, apply };
