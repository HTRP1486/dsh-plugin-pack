/**
 * 本地导入插件：把一个已存在的插件目录接进当前 profile。
 *
 * 与整合包导入的区别：那边读 zip，这边直接指向磁盘上的目录
 * （自己写的插件、已经解压好的插件、或 node_modules 里已有的包）。
 *
 * 做的事和整合包导入一致，只是源不同：
 *   复制到 profile/local-plugins/<名字> → 写 dependencies(link:) + bundles
 *   → 合并 cordis.patch.yml 里属于它的行 → 建 node_modules 链接 → 备份可回滚
 *
 * @module dsh-plugin-pack/import-plugin
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson, readText, writeText, ensureDir, isDir, isFile, copyTree, removeTree } from './util.js';
import { packSegment, stamp, humanBytes } from './home.js';
import { existingIds, rowId, splitTopLevel, splitInsertChildren, entryMatchesPlugin, appendInsertBlock } from './patch-text.js';
import { resolveEntry, isAbsoluteSpec } from './scan.js';

/** 从一个目录读出插件身份，判断它能不能装。 */
export function describeLocalPlugin(dir) {
  const target = path.resolve(dir);
  if (!isDir(target)) {
    const error = new Error(`不是目录: ${target}`);
    error.code = 'NOT_FOUND';
    throw error;
  }
  const meta = readJson(path.join(target, 'package.json'), null);
  if (!meta || typeof meta.name !== 'string' || !meta.name.trim()) {
    const error = new Error(`目录里没有可用的 package.json（需要 name 字段）: ${target}`);
    error.code = 'BAD_PLUGIN';
    throw error;
  }
  const entry = resolveEntry(target, meta);
  const patchRel = typeof meta?.dsh?.bundle?.patch === 'string' ? meta.dsh.bundle.patch : null;
  return {
    dir: target,
    name: meta.name.trim(),
    version: meta.version ?? '0.0.0',
    description: typeof meta.description === 'string' ? meta.description : '',
    entry,
    hasPatch: patchRel ? isFile(path.join(target, patchRel)) : false,
    patchRel,
    client: meta.dsh?.client ?? null,
    deps: Object.keys(meta.dependencies ?? {}).filter((dep) => !dep.startsWith('@deepseek-ai/')),
  };
}

/**
 * 导入本地插件。
 *
 * @param {object} options
 * @param {string} options.dir 插件目录
 * @param {string} options.profileDir profile 目录
 * @param {boolean} [options.dryRun]
 * @param {'merge'|'skip'} [options.mode]
 * @param {boolean} [options.linkNodeModules]
 * @param {boolean} [options.keepNodeModules]
 *   true = 连目录里的 node_modules 一起搬过去。
 *   从 .tgz 解出来的包必须为 true —— 它的依赖就在那儿，不搬过去插件加载会失败。
 * @returns {object}
 */
export function importLocalPlugin(options = {}) {
  const profile = path.resolve(options.profileDir);
  const mode = options.mode === 'skip' ? 'skip' : 'merge';
  const dryRun = Boolean(options.dryRun);
  const linkNodeModules = options.linkNodeModules !== false;
  const keepNodeModules = options.keepNodeModules === true;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const info = describeLocalPlugin(options.dir);
  const segment = packSegment(info.name);
  const dest = path.join(profile, 'local-plugins', segment);
  const exists = isDir(dest);
  // 逐插件决策优先；没给就退回全局 mode
  const decided = options.decisions?.[info.name];
  const action = exists
    ? decided === 'skip' || decided === 'overwrite'
      ? decided
      : mode === 'skip'
        ? 'skip'
        : 'overwrite'
    : 'create';

  // 读 profile 现状
  const pkgFile = path.join(profile, 'package.json');
  const patchFile = path.join(profile, 'cordis.patch.yml');
  const pkg = readJson(pkgFile, { name: `dsh-profile`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } });
  const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? [...pkg.dsh.profile.bundles] : [];
  const patchText = readText(patchFile, '') ?? '';
  const knownIds = existingIds(patchText);

  // 这个插件自己的 patch 行（从它自带的 cordis.patch.yml 里读）
  const patchRows = [];
  const insertRows = [];
  const skippedRows = [];
  if (info.hasPatch) {
    const ownPatch = readText(path.join(info.dir, info.patchRel), '') ?? '';
    const target = { name: info.name, dirs: [info.dir] };
    for (const entry of splitTopLevel(ownPatch)) {
      if (entry.kind === 'insert') {
        for (const child of splitInsertChildren(entry.raw)) {
          const id = rowId(child.raw);
          if (!id) continue;
          if (knownIds.has(id)) {
            skippedRows.push(id);
            continue;
          }
          knownIds.add(id);
          insertRows.push(child.raw);
        }
        continue;
      }
      if (entry.kind !== 'row') continue;
      if (!entryMatchesPlugin(entry, target)) continue;
      const id = rowId(entry.raw);
      if (!id || knownIds.has(id)) {
        if (id) skippedRows.push(id);
        continue;
      }
      knownIds.add(id);
      patchRows.push(entry.raw);
    }
  }

  const inBundles = bundles.includes(info.name);
  const plan = {
    name: info.name,
    version: info.version,
    dir: info.dir,
    dest,
    action,
    inBundles,
    entry: info.entry,
    hasPatch: info.hasPatch,
    patchRows: patchRows.length,
    insertRows: insertRows.length,
    skippedRows,
    deps: info.deps.length,
    bytes: measureLocal(info.dir),
  };

  // 冲突信息：单个插件也可能已装过，界面据此弹窗
  const conflicts = exists
    ? [
        {
          name: info.name,
          version: info.version,
          installedVersion: readJson(path.join(dest, 'package.json'), null)?.version ?? null,
          dest,
          bytes: plan.bytes,
          sameVersion: readJson(path.join(dest, 'package.json'), null)?.version === info.version,
        },
      ]
    : [];

  if (dryRun) {
    return { ok: true, dryRun: true, plan, conflicts, restartRequired: true };
  }
  if (action === 'skip') {
    return { ok: true, skipped: true, plan, conflicts, restartRequired: false, note: '目标已存在，按选择跳过' };
  }

  // --- 备份 ---
  const backupRoot = uniqueDir(path.join(profile, '.plugin-backups', `plugin-pack-import-${stamp()}`));
  ensureDir(backupRoot);
  if (isFile(pkgFile)) fs.copyFileSync(pkgFile, path.join(backupRoot, 'package.json'));
  if (isFile(patchFile)) fs.copyFileSync(patchFile, path.join(backupRoot, 'cordis.patch.yml'));
  const record = {
    format: 'dsh-plugin-pack-backup@1',
    createdAt: new Date().toISOString(),
    source: `local-plugin:${info.dir}`,
    profile,
    addedDirs: [],
    replacedDirs: [],
    removedLinks: [],
    links: [],
    dataDirs: [],
  };

  // --- 复制本体 ---
  if (exists) {
    const backupDir = path.join(backupRoot, 'local-plugins', segment);
    copyTree(dest, backupDir);
    record.replacedDirs.push({ dest, backup: backupDir });
    removeTree(dest);
  } else {
    record.addedDirs.push(dest);
  }
  ensureDir(path.dirname(dest));
  onProgress(`复制 ${info.name} 到 local-plugins`, 50);
  copyTree(info.dir, dest, {
    filter: (src) => {
      const rel = path.relative(info.dir, src);
      if (!rel) return true;
      const first = rel.split(path.sep)[0];
      if (first === '.git') return false;
      // node_modules 是否带上，取决于这次导入的来源：
      //   - 从 .tgz 解出来的包：依赖就在 node_modules 里，必须原样带过来，
      //     否则插件一加载就 ERR_MODULE_NOT_FOUND（dsh-pet 的 @electron/get 事故）
      //   - 直接导入本地插件目录：依赖由用户自己的 pnpm 管理，不复制（可能几百 MB）
      if (first === 'node_modules' && !keepNodeModules) return false;
      return true;
    },
  });

  // --- 写 profile/package.json ---
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {};
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  // 是"路径插件"（patch 里靠绝对路径挂的）就不进 bundles/依赖
  const pathPlugin = Boolean(info.hasPatch) && !info.entry;
  if (!pathPlugin) {
    pkg.dependencies[info.name] = `link:./local-plugins/${segment}`;
    if (!pkg.dsh.profile.bundles.includes(info.name)) pkg.dsh.profile.bundles.push(info.name);
  }
  writeJson(pkgFile, pkg);

  // --- 合并 patch 行 ---
  let nextPatch = patchText;
  if (patchRows.length) {
    nextPatch = appendTopRows(nextPatch, patchRows.map((raw) => rewriteAbsName(raw, info.name)), `plugin-pack import ${info.name}`);
  }
  if (insertRows.length) {
    nextPatch = appendInsertBlock(nextPatch, dedentRows(insertRows), `plugin-pack import ${info.name}`).text;
  }
  if (nextPatch !== patchText) writeText(patchFile, nextPatch);

  // --- 建链接 ---
  let link = null;
  if (linkNodeModules && !pathPlugin) {
    onProgress('建立 node_modules 链接', 85);
    link = ensureLink(profile, info.name, dest, { backupRoot, record });
  }

  record.links = link ? [link] : [];
  writeJson(path.join(backupRoot, 'record.json'), record);

  return {
    ok: true,
    plan,
    name: info.name,
    version: info.version,
    dest,
    entry: info.entry,
    deps: info.deps,
    link,
    backup: backupRoot,
    restartRequired: true,
    note: '重启 dsh 加载这个插件；如果它带客户端界面，之后可以用热加载',
  };
}

/** 目录大小（跳过 .git / node_modules）。 */
function measureLocal(dir) {
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return bytes;
}

/** 唯一的备份目录。 */
function uniqueDir(base) {
  if (!isDir(base) && !isFile(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!isDir(candidate) && !isFile(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** 顶层 row 追加。 */
function appendTopRows(text, rows, comment) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  let out = String(text ?? '');
  if (out && !out.endsWith('\n')) out += eol;
  if (out && !out.endsWith(`${eol}${eol}`)) out += eol;
  out += `# >>> dsh-plugin-pack ${comment}${eol}`;
  for (const row of rows) {
    out += `${String(row).replace(/\r?\n$/, '').replace(/\r?\n/g, eol)}${eol}`;
  }
  return out;
}

/** insert 子条目去掉 4 空格缩进（交给 appendInsertBlock 重新缩进）。 */
function dedentRows(rows) {
  return rows.map((raw) =>
    String(raw)
      .split(/\r?\n/)
      .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
      .join('\n'),
  );
}

/** 把写死的绝对路径 name 改回包名。 */
function rewriteAbsName(raw, packageName) {
  return String(raw).replace(/(^|[ \t])name:([ \t]*)(['"]?)([^'"\r\n]+)\3/g, (match, lead, gap, quote, value) => {
    const trimmed = String(value).trim();
    if (!isAbsoluteSpec(trimmed)) return match;
    return `${lead}name:${gap}${quote}${packageName}${quote}`;
  });
}

/** 建 node_modules/<name> → dest 链接。 */
function ensureLink(profile, name, dest, { backupRoot, record }) {
  const linkPath = path.join(profile, 'node_modules', ...String(name).split('/'));
  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
      record.removedLinks.push(linkPath);
    } else if (stat.isDirectory()) {
      const backup = path.join(backupRoot, 'node_modules', packSegment(name));
      copyTree(linkPath, backup);
      record.replacedDirs.push({ dest: linkPath, backup });
      removeTree(linkPath);
    } else {
      fs.unlinkSync(linkPath);
    }
  } catch {
    /* 不存在，直接建 */
  }
  try {
    ensureDir(path.dirname(linkPath));
    fs.symlinkSync(dest, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return { status: 'linked', path: linkPath };
  } catch (error) {
    return { status: 'failed', path: linkPath, error: `建链接失败: ${error?.message ?? error}` };
  }
}
