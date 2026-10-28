#!/usr/bin/env node
/**
 * 脱离 dsh 宿主的命令行入口。
 *
 * 用法：
 *   dsh-plugin-pack list
 *   dsh-plugin-pack export [--out <zip|目录>] [--include a,b] [--exclude a,b]
 *                         [--data] [--secrets] [--dry] [--max-bytes N]
 *   dsh-plugin-pack inspect <zip>
 *   dsh-plugin-pack import <zip> [--dry] [--skip] [--no-data] [--no-link] [--overwrite]
 *   dsh-plugin-pack rollback [备份名]
 *   dsh-plugin-pack backups
 *
 * 也可以直接：node bin/dsh-plugin-pack.js ...
 *
 * @module dsh-plugin-pack/bin
 */
import path from 'node:path';

import { scanProfile } from '../lib/scan.js';
import { exportBundle } from '../lib/export.js';
import { importBundle, inspectBundle, rollbackImport, listBackups } from '../lib/import.js';
import { importTarball, isTarball } from '../lib/import-tgz.js';
import { dshHome as resolveDshHome, profileDir as resolveProfileDir, humanBytes } from '../lib/home.js';
import { renderList, renderExport, renderImport, renderInspect } from '../lib/index.js';

/** 布尔 flag：后面即使跟普通参数也不吞。 */
const BOOL_FLAGS = new Set(['dry', 'skip', 'no-data', 'no-link', 'overwrite', 'data', 'secrets', 'help']);

function parseArgv(argv) {
  const positional = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags.set(key, inline);
        continue;
      }
      if (BOOL_FLAGS.has(key)) {
        flags.set(key, true);
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags.set(key, next);
        i += 1;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    positional.push(token);
  }
  return { positional, flags };
}

function splitList(value) {
  if (typeof value !== 'string') return null;
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function context() {
  return {
    home: resolveDshHome(),
    profileDir: resolveProfileDir(),
  };
}

async function main() {
  const { positional, flags } = parseArgv(process.argv.slice(2));
  const sub = (positional[0] ?? 'help').toLowerCase();
  const ctx = context();

  switch (sub) {
    case 'list':
    case 'ls': {
      const scan = await scanProfile({
        includeData: Boolean(flags.get('data')),
        includeSecrets: Boolean(flags.get('secrets')),
      });
      console.log(renderList(scan, ctx, listBackups(ctx.profileDir)));
      return 0;
    }
    case 'export':
    case 'e': {
      const result = await exportBundle({
        out: positional[1] ?? (flags.get('out') || path.join(ctx.home, 'exports')),
        include: splitList(flags.get('include')),
        exclude: splitList(flags.get('exclude')) ?? [],
        includeData: Boolean(flags.get('data')),
        includeSecrets: Boolean(flags.get('secrets')),
        maxBytes: flags.get('max-bytes') ? Number(flags.get('max-bytes')) : undefined,
        dryRun: Boolean(flags.get('dry')),
        onProgress: (message) => console.error(`  ${message}`),
      });
      console.log(renderExport(result));
      return 0;
    }
    case 'inspect':
    case 'i': {
      const file = positional[1];
      if (!file) {
        console.error('用法: dsh-plugin-pack inspect <zip>');
        return 2;
      }
      console.log(renderInspect(inspectBundle(file)));
      return 0;
    }
    case 'import': {
      const file = positional[1];
      if (!file) {
        console.error('用法: dsh-plugin-pack import <zip|tgz> [--dry] [--skip] [--no-data] [--no-link]');
        return 2;
      }
      // 按扩展名分流：tgz/tar.gz 是单插件的 npm tarball，其余按整合包处理
      if (isTarball(file)) {
        const result = importTarball({
          file,
          home: ctx.home,
          profileDir: ctx.profileDir,
          dryRun: Boolean(flags.get('dry')),
          mode: flags.get('skip') ? 'skip' : 'merge',
        });
        if (flags.get('dry')) {
          console.log(`[dry-run] 将导入单插件: ${result.plan?.name ?? '(未知)'}`);
          console.log(`  来自 tarball: ${file}`);
        } else {
          console.log(`✓ 已从 tarball 导入单插件: ${result.name}@${result.version}`);
          console.log(`  落地: ${result.dest}`);
          console.log(`  备份: ${result.backup}`);
          console.log('重启 dsh 生效。');
        }
        return 0;
      }
      const result = importBundle({
        file,
        dryRun: Boolean(flags.get('dry')),
        mode: flags.get('skip') ? 'skip' : 'merge',
        overwritePatchConfig: Boolean(flags.get('overwrite')),
        restoreData: !flags.get('no-data'),
        linkNodeModules: !flags.get('no-link'),
        only: splitList(flags.get('only')),
      });
      console.log(renderImport(result));
      return 0;
    }
    case 'rollback':
    case 'undo': {
      const result = rollbackImport({ backup: positional[1] });
      console.log(`✓ 已回滚到 ${result.backup}`);
      console.log(`恢复: ${result.restored.join(', ') || '(无)'}`);
      console.log(`删除: ${result.removed.length} 项  解链: ${result.unlinked.length} 项`);
      console.log('重启 dsh 生效。');
      return 0;
    }
    case 'backups':
    case 'b': {
      const backups = listBackups(ctx.profileDir);
      if (!backups.length) {
        console.log('还没有导入备份。');
        return 0;
      }
      for (const item of backups) {
        console.log(`${item.name}  ${item.createdAt ?? ''}  ${item.plugins} 项  ${item.source ?? ''}`);
      }
      return 0;
    }
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(
        [
          'dsh-plugin-pack — dsh 插件整合包一键导出/导入',
          '',
          '  dsh-plugin-pack list',
          '  dsh-plugin-pack export [--out <zip|目录>] [--include a,b] [--exclude a,b]',
          '                        [--data] [--secrets] [--dry] [--max-bytes N]',
          '  dsh-plugin-pack inspect <zip>',
          '  dsh-plugin-pack import <zip> [--dry] [--skip] [--no-data] [--no-link] [--overwrite]',
          '  dsh-plugin-pack rollback [备份名]',
          '  dsh-plugin-pack backups',
          '',
          `当前 profile: ${ctx.profileDir}`,
          `默认导出目录: ${path.join(ctx.home, 'exports')}`,
        ].join('\n'),
      );
      return 0;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`ERROR: ${error?.message ?? error}`);
  if (process.env.DSH_PLUGIN_PACK_DEBUG) console.error(error?.stack);
  process.exitCode = 1;
}
