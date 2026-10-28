/**
 * dsh-plugin-pack 客户端界面。
 *
 * 两个挂载点：
 *   1. plugins.row.config —— 插件页「已安装」列表里点开 dsh-plugin-pack 这一行（主入口）
 *        summary view：列表里那一行的一行简介
 *        page view   ：点进去的详情页，完整面板
 *   2. settings.section  —— 「设置 → 插件整合包」整页，同一个面板
 *
 * 不再往会话界面塞常驻浮动按钮（shell.overlay）：入口就在插件页里，不占屏幕。
 *
 * 所有文件操作都走宿主的 /plugin-pack/* 接口，客户端不碰文件系统。
 *
 * 这段代码由宿主的客户端模块加载器执行，通过 require('react') 拿 React，
 * 不依赖 JSX 编译产物，所以整个文件就是一个 factory。
 *
 * @module dsh-plugin-pack/client
 */
window.__ModuleLoader__.load({ id: 'dsh-plugin-pack', factory: (require) => {
  const module = { exports: {} };
  const exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

  const react = require('react');
  const h = react.createElement;
  const { useState, useEffect, useCallback, useRef, useMemo } = react;

  const name = 'dsh-plugin-pack';
  // 只声明真正用到的服务：slots 用来挂界面，locale 用来做中英文案。
  // 多声明一个不存在的服务会让 cordis 一直等它，导致整页不渲染。
  const inject = ['slots', 'locale'];

  const NS = 'dsh-plugin-pack';

  /* ---------------------------------- 文案 --------------------------------- */

  const zh = {
    'nav': '插件整合包',
    'summary': '点开可一键导出/导入全部插件',
    'title': '插件整合包',
    'hotload': '热加载界面',
    'hotload.running': '正在热加载…',
    'hotload.done': '界面已热加载，刷新页面即可看到',
    'hotload.failed': '热加载失败',
    'hotload.why': '改完插件配置或 client 代码后，点这里不用重启 dsh。',
    'subtitle': '把当前 profile 的所有第三方插件连依赖和配置打成一个 zip，换机一键还原。',
    'tab.export': '导出',
    'tab.import': '导入',
    'tab.backup': '备份与回滚',
    'tab.help': '怎么用',
    'tab.navImport': '导入',
    'tab.navExport': '导出',
    'refresh': '刷新',
    'loading': '读取中…',
    'failed': '读取失败',
    'retry': '重试',
    'profile': '当前 profile',
    'profileDir': '目录',
    'dshHome': 'DSH_HOME',
    'plugins': '插件',
    'total': '合计',
    'selectAll': '全选',
    'selectNone': '全不选',
    'selected': '已选',
    'files': '文件',
    'deps': '依赖',
    'patch': '配置行',
    'data': '数据目录',
    'notPlugin': '非插件',
    'warning': '提示',
    'export.title': '导出整合包',
    'export.desc': '勾选要带走的插件，下面选好存到哪，点「开始导出」。',
    'export.out': '保存到',
    'export.outHint': '留空就用默认目录；写目录会自动加文件名',
    'export.includeData': '连插件数据目录一起打包',
    'export.includeDataHint': '比如 lark-plus 的登录态、purge 的规则。可能含敏感信息',
    'export.includeSecrets': '连 .env / 密钥文件一起打包',
    'export.includeSecretsHint': '默认剔除。要发给别人时务必保持关闭',
    'export.dry': '预演（只算体积）',
    'export.maxMb': '体积上限',
    'export.maxMbHint': '0 = 不限制。带原生二进制的插件（如 dsh-ops、dsh-pet）单个体积就很大。',
    'export.maxMbFit': '按当前选择自动调大',
    'export.maxMbNone': '不限制',
    'export.overLimit': '所选插件超过上限，导出会失败',
    'export.run': '开始导出',
    'export.running': '正在打包…',
    'export.done': '导出完成',
    'export.empty': '先勾选至少一个插件',
    'export.size': '包体积',
    'export.raw': '未压缩',
    'export.entries': '条目数',
    'import.title': '导入整合包',
    'import.desc': '选一个 zip，先「查看内容」确认是你要的，再「开始导入」。导入前会自动备份现有配置。',
    'import.pick': '选择文件',
    'import.pathHint': '也可以直接把 zip 路径粘到这里',
    'import.inspect': '查看内容',
    'import.run': '开始导入',
    'import.running': '正在导入…',
    'import.dry': '预演（不写任何文件）',
    'import.mode': '目标已存在时',
    'import.modeMerge': '覆盖',
    'import.modeSkip': '跳过',
    'import.restoreData': '还原数据目录',
    'import.link': '建立 node_modules 链接',
    'import.done': '导入完成',
    'import.restart': '重启 dsh 后生效',
    'import.empty': '先选一个 zip 文件',
    'import.source.bundle': '整合包',
    'import.source.plugin': '本地插件',
    'import.notBundle': 'zip 不是整合包',
    'drop.title': '把 zip / tgz 或插件文件夹拖到这里',
    'drop.release': '松手就导入',
    'drop.running': '正在导入…',
    'drop.hint': 'zip = 整合包，tgz = 单个插件；点这里也能选文件',
    'browse.titleDir': '选择目录',
    'browse.titleFile': '选择文件',
    'browse.pick': '选这个目录',
    'browse.pickDir': '选这个目录',
    'browse.pickHere': '用当前这个目录',
    'browse.jumpOk': '已跳转',
    'browse.jumpEmpty': '先在上面填一个路径，或从下面点进去',
    'browse.jumpSame': '已经在这个目录了；要选它就直接点右下角的按钮',
    'browse.pathHint': '粘贴完整路径，回车或点到别处即确认（目录或 zip 都行）',
    'browse.enter': '选它',
    'browse.open': '进入',
    'import.plugin.title': '本地导入插件',
    'import.plugin.desc': '把一个已经在本机的插件目录接进当前 profile：复制到 local-plugins、写进 bundles、建好链接。',
    'import.plugin.dir': '插件目录',
    'import.plugin.dirHint': '选插件所在目录（含 package.json），例如 D:\\Documents\\my-plugin',
    'import.plugin.run': '导入这个插件',
    'import.plugin.done': '插件已导入',
    'import.plugin.empty': '先选一个插件目录',
    'import.plugin.note': '适合自己写的插件，或已经解压到本地的插件。整合包（zip）请用左边的「整合包」页签。',
    'export.source.bundle': '整合包（全部）',
    'export.source.plugin': '单个插件',
    // 勾选数量自动决定导出类型，不需要用户选
    'export.scope.none': '勾选插件：勾 1 个导出单个插件，勾多个导出整合包',
    'export.scope.single': '将导出单个插件',
    'export.scope.bundle': '将导出整合包',
    'export.plugin.title': '导出单个插件',
    'export.plugin.desc': '只把勾选的这一个插件连依赖打成一个 zip，方便单独分享。',
    'export.plugin.pick': '选要导出的插件',
    'export.plugin.run': '导出这个插件',
    'jobs.title': '后台任务',
    'jobs.kindExport': '导出',
    'jobs.kindImport': '导入整合包',
    'jobs.kindImportPlugin': '导入插件',
    'jobs.kindRollback': '回滚',
    'jobs.running': '进行中',
    'jobs.done': '已完成',
    'jobs.failed': '失败',
    'jobs.clear': '清空已完成',
    'conflict.title': '这些插件已经装过了',
    'conflict.subtitle': '个插件与已安装的重名，请选择如何处理：',
    'conflict.overwrite': '覆盖',
    'conflict.skip': '跳过',
    'conflict.allOverwrite': '全部覆盖',
    'conflict.allSkip': '全部跳过',
    'conflict.sameVersion': '同版本',
    'conflict.confirm': '开始导入',
    'conflict.cancel': '取消',
    'backup.title': '备份与回滚',
    'backup.desc': '每次导入都会在这里留一份快照。不满意就点「回滚」，配置和插件目录一起还原。',
    'backup.none': '还没有导入备份',
    'backup.rollback': '回滚',
    'backup.rolling': '正在回滚…',
    'backup.done': '回滚完成',
    'backup.confirm': '确定要回滚到这份备份吗？本次导入新增的插件会被删掉。',
    'backup.createdAt': '时间',
    'backup.items': '项',
    'recent.title': '最近导出',
    'recent.none': '这个目录里还没有整合包',
    'recent.import': '导入这个',
    'help.title': '怎么用（不用记命令）',
    'help.step1': '第一步：在这页勾选你想带走的插件，点「开始导出」，得到一个 zip 文件。',
    'help.step2': '第二步：把 zip 拷到新电脑（或另一个 profile）。',
    'help.step3': '第三步：在新机器上打开这页，切到「导入」，选那个 zip，点「开始导入」。',
    'help.step4': '第四步：重启 dsh。插件、依赖、配置、开关全部照原样回来。',
    'help.note1': '不用敲命令：这个页面做什么，跟 /pack 命令完全等价。',
    'help.note2': '只想备份不想换机？把导出的 zip 留着就是备份，随时能导入回来。',
    'help.note3': '导入不满意：切到「备份与回滚」，一键回到导入前的状态。',
    'help.note4': '想改这个插件自己？右上角「热加载界面」按钮，改完不用重启 dsh。',
    'help.advanced': '进阶：也可以用命令或直接对 agent 说',
    'help.cmd': '/pack export    /pack import <zip>    /pack rollback',
    'browse.title': '选择目录',
    'browse.up': '上一级',
    'browse.pick': '选这个目录',
    'browse.cancel': '取消',
    'common.cancel': '取消',
    'common.close': '关闭',
    'errors.crossOrigin': '跨站请求被拒绝',
    'errors.offline': '连不上插件接口，确认 dsh 还在跑，然后刷新页面',
  };

  const en = {
    'nav': 'Plugin Pack',
    'summary': 'Open to export or import every plugin in one step',
    'title': 'Plugin Pack',
    'hotload': 'Hot-reload UI',
    'hotload.running': 'Hot-reloading…',
    'hotload.done': 'UI hot-reloaded, refresh the page to see it',
    'hotload.failed': 'Hot-reload failed',
    'hotload.why': 'After editing plugin config or client code, click here instead of restarting dsh.',
    'subtitle': 'Bundle every third-party plugin with its deps and config into one zip; restore on another machine in one click.',
    'tab.export': 'Export',
    'tab.import': 'Import',
    'tab.backup': 'Backup',
    'tab.help': 'How to',
    'tab.navImport': 'Import',
    'tab.navExport': 'Export',
    'refresh': 'Refresh',
    'loading': 'Loading…',
    'failed': 'Failed to load',
    'retry': 'Retry',
    'profile': 'Profile',
    'profileDir': 'Directory',
    'dshHome': 'DSH_HOME',
    'plugins': 'Plugins',
    'total': 'Total',
    'selectAll': 'Select all',
    'selectNone': 'Select none',
    'selected': 'selected',
    'files': 'Files',
    'deps': 'Deps',
    'patch': 'Patch rows',
    'data': 'Data dirs',
    'notPlugin': 'not a plugin',
    'warning': 'Note',
    'export.title': 'Export a bundle',
    'export.desc': 'Tick the plugins to take, choose where to save, then press Export.',
    'export.out': 'Save to',
    'export.outHint': 'Leave empty for the default folder; a filename is added for directories',
    'export.includeData': 'Include plugin data directories',
    'export.includeDataHint': 'e.g. lark-plus login state, purge rules. May contain secrets',
    'export.includeSecrets': 'Include .env / key files',
    'export.includeSecretsHint': 'Excluded by default. Keep off when sharing',
    'export.dry': 'Dry run (size only)',
    'export.maxMb': 'Size limit',
    'export.maxMbHint': '0 = unlimited. Plugins with native binaries (dsh-ops, dsh-pet) are large on their own.',
    'export.maxMbFit': 'Raise to fit selection',
    'export.maxMbNone': 'Unlimited',
    'export.overLimit': 'Selection exceeds the limit; export will fail',
    'export.run': 'Export',
    'export.running': 'Packing…',
    'export.done': 'Export finished',
    'export.empty': 'Tick at least one plugin',
    'export.size': 'Bundle size',
    'export.raw': 'Uncompressed',
    'export.entries': 'Entries',
    'import.title': 'Import a bundle',
    'import.desc': 'Pick a zip, inspect it first, then import. Current config is backed up automatically.',
    'import.pick': 'Choose file',
    'import.pathHint': 'Or paste the zip path here',
    'import.inspect': 'Inspect',
    'import.run': 'Import',
    'import.running': 'Importing…',
    'import.dry': 'Dry run (writes nothing)',
    'import.mode': 'If target exists',
    'import.modeMerge': 'Overwrite',
    'import.modeSkip': 'Skip',
    'import.restoreData': 'Restore data dirs',
    'import.link': 'Link node_modules',
    'import.done': 'Import finished',
    'import.restart': 'Restart dsh to apply',
    'import.empty': 'Choose a zip first',
    'import.source.bundle': 'Bundle',
    'import.source.plugin': 'Local plugin',
    'import.notBundle': 'This zip is not a bundle',
    'drop.title': 'Drop a zip / tgz or plugin folder here',
    'drop.release': 'Release to import',
    'drop.running': 'Importing…',
    'drop.hint': 'zip = bundle, tgz = single plugin; click to pick files too',
    'browse.titleDir': 'Choose a folder',
    'browse.titleFile': 'Choose a file',
    'browse.pick': 'Use this folder',
    'browse.pickDir': 'Use this folder',
    'browse.pickHere': 'Use current folder',
    'browse.jumpOk': 'Jumped',
    'browse.jumpEmpty': 'Type a path above, or click into a folder below',
    'browse.jumpSame': 'Already in this folder; use the button at the bottom right to pick it',
    'browse.pathHint': 'Paste a full path; Enter or clicking away confirms (folder or zip)',
    'browse.enter': 'Pick',
    'browse.open': 'Open',
    'import.plugin.title': 'Import a local plugin',
    'import.plugin.desc': 'Wire an existing plugin directory into this profile: copy to local-plugins, add to bundles, link it.',
    'import.plugin.dir': 'Plugin directory',
    'import.plugin.dirHint': 'Pick the directory containing package.json, e.g. D:\\Documents\\my-plugin',
    'import.plugin.run': 'Import this plugin',
    'import.plugin.done': 'Plugin imported',
    'import.plugin.empty': 'Choose a plugin directory first',
    'import.plugin.note': 'For plugins you wrote yourself or already unpacked locally. Use the Bundle tab for a zip.',
    'export.source.bundle': 'Bundle (all)',
    'export.source.plugin': 'Single plugin',
    'export.scope.none': 'Tick plugins: 1 = single plugin, several = bundle',
    'export.scope.single': 'Exporting a single plugin',
    'export.scope.bundle': 'Exporting a bundle',
    'export.plugin.title': 'Export one plugin',
    'export.plugin.desc': 'Bundle just the ticked plugin with its deps into one zip, easy to share.',
    'export.plugin.pick': 'Pick the plugin to export',
    'export.plugin.run': 'Export this plugin',
    'jobs.title': 'Background tasks',
    'jobs.kindExport': 'Export',
    'jobs.kindImport': 'Import bundle',
    'jobs.kindImportPlugin': 'Import plugin',
    'jobs.kindRollback': 'Rollback',
    'jobs.running': 'Running',
    'jobs.done': 'Done',
    'jobs.failed': 'Failed',
    'jobs.clear': 'Clear finished',
    'conflict.title': 'These plugins are already installed',
    'conflict.subtitle': 'plugins already exist. Choose what to do:',
    'conflict.overwrite': 'Overwrite',
    'conflict.skip': 'Skip',
    'conflict.allOverwrite': 'Overwrite all',
    'conflict.allSkip': 'Skip all',
    'conflict.sameVersion': 'same version',
    'conflict.confirm': 'Start import',
    'conflict.cancel': 'Cancel',
    'backup.title': 'Backups',
    'backup.desc': 'Every import leaves a snapshot here. Roll back to restore config and plugin dirs.',
    'backup.none': 'No import backups yet',
    'backup.rollback': 'Roll back',
    'backup.rolling': 'Rolling back…',
    'backup.done': 'Rollback finished',
    'backup.confirm': 'Roll back to this snapshot? Plugins added by that import will be removed.',
    'backup.createdAt': 'Time',
    'backup.items': 'items',
    'recent.title': 'Recent exports',
    'recent.none': 'No bundles in this folder yet',
    'recent.import': 'Import this',
    'help.title': 'How to use (no commands needed)',
    'help.step1': 'Step 1: tick the plugins on this page and press Export — you get one zip.',
    'help.step2': 'Step 2: copy the zip to the new machine (or another profile).',
    'help.step3': 'Step 3: open this page there, switch to Import, pick the zip, press Import.',
    'help.step4': 'Step 4: restart dsh. Plugins, deps, config and toggles all come back.',
    'help.note1': 'No typing needed: this page does exactly what the /pack command does.',
    'help.note2': 'Only want a backup? Keep the exported zip — you can import it any time.',
    'help.note3': 'Not happy with an import? Open Backup and roll back in one click.',
    'help.note4': 'Modifying this plugin itself? Use the "Hot-reload UI" button — no restart needed.',
    'help.advanced': 'Advanced: commands or just ask the agent',
    'help.cmd': '/pack export    /pack import <zip>    /pack rollback',
    'browse.title': 'Choose a folder',
    'browse.up': 'Up',
    'browse.pick': 'Use this folder',
    'browse.cancel': 'Cancel',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'errors.crossOrigin': 'Cross-site request blocked',
    'errors.offline': 'Cannot reach the plugin API. Check dsh is running, then refresh',
  };

  /* ---------------------------------- 样式 --------------------------------- */

  const CSS = `
.pp-root{box-sizing:border-box;font-family:var(--dsw-font-family,inherit);font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#111)}
.pp-root *,.pp-root *::before,.pp-root *::after{box-sizing:border-box}
.pp-wrap{max-width:1080px;margin:0 auto;padding:4px 2px 32px}
.pp-h1{font-size:20px;line-height:28px;font-weight:600;margin:0 0 6px}
.pp-sub{color:var(--dsw-alias-label-secondary,#6b7280);margin:0 0 18px;font-size:13px;line-height:20px}
.pp-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.pp-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-secondary,#6b7280)}
.pp-pill b{color:var(--dsw-alias-label-primary,#111);font-weight:600}
.pp-btn{appearance:none;cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:5px 13px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,#d5d5d5);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);transition:background .12s}
.pp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.pp-btn:disabled{opacity:.5;cursor:not-allowed}
.pp-btn.primary{background:var(--dsw-alias-button-primary-fill,#111);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:500}
.pp-btn.primary:hover:not(:disabled){filter:brightness(1.12)}
.pp-btn.danger{border-color:var(--dsw-alias-state-error-primary,#dc2626);color:var(--dsw-alias-state-error-primary,#dc2626)}
.pp-btn.sm{font-size:12px;padding:3px 9px;border-radius:6px}
.pp-tabs{display:flex;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l1,#ececec);margin-bottom:16px}
.pp-tab{appearance:none;border:0;border-bottom:2px solid transparent;background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;padding:7px 12px;margin-bottom:-1px;color:var(--dsw-alias-label-secondary,#6b7280);border-radius:0}
.pp-tab:hover{color:var(--dsw-alias-label-primary,#111)}
.pp-tab.on{color:var(--dsw-alias-label-primary,#111);font-weight:500;border-bottom-color:var(--dsw-alias-label-primary,#111)}
.pp-card{border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:12px;padding:14px 16px;margin-bottom:14px;background:var(--dsw-alias-bg-layer-1,#fff)}
.pp-card h3{font-size:15px;line-height:22px;font-weight:600;margin:0 0 4px}
.pp-card p.pp-desc{color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px;line-height:20px;margin:0 0 12px}
.pp-list{border:.5px solid var(--dsw-alias-border-l2,#e5e5e5);border-radius:10px;overflow:hidden}
.pp-row{display:flex;align-items:flex-start;gap:10px;padding:9px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1,#f0f0f0)}
.pp-row:last-child{border-bottom:0}
.pp-row:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 5%,transparent))}
.pp-row input[type=checkbox]{margin:3px 0 0;flex:none;width:15px;height:15px;cursor:pointer;accent-color:var(--dsw-alias-button-primary-fill,#111)}
.pp-row .pp-main{flex:1;min-width:0}
.pp-row .pp-name{font-weight:500;font-size:13px;line-height:20px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.pp-row .pp-ver{font-size:11px;line-height:16px;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-secondary,#6b7280);font-weight:400}
.pp-row .pp-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:1px}
.pp-row .pp-warn{font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,#b45309);margin-top:2px}
.pp-row.pp-dim{opacity:.55}
.pp-side{flex:none;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#6b7280);white-space:nowrap}
.pp-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.pp-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary,#111)}
.pp-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#6b7280)}
.pp-input{font:inherit;font-size:13px;line-height:20px;padding:6px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l4,#d0d0d0);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);width:100%;outline:none}
.pp-input:focus{border-color:var(--dsw-alias-label-primary,#111)}
.pp-input-row{display:flex;gap:8px;align-items:center}
.pp-check{display:flex;align-items:flex-start;gap:8px;padding:7px 0;cursor:pointer}
.pp-check input{margin:3px 0 0;flex:none;width:15px;height:15px;accent-color:var(--dsw-alias-button-primary-fill,#111);cursor:pointer}
.pp-check .pp-check-body{flex:1}
.pp-check .pp-check-title{font-size:13px;line-height:20px}
.pp-note{border-left:2px solid var(--dsw-alias-border-l4,#d0d0d0);padding:2px 0 2px 10px;margin:10px 0 0;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#6b7280)}
.pp-out{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;word-break:break-all;background:var(--dsw-alias-markdown-code-block,#f7f7f8);border-radius:8px;padding:9px 11px;margin:10px 0 0;color:var(--dsw-alias-label-primary,#111)}
.pp-alert{border-radius:8px;padding:9px 12px;font-size:12px;line-height:19px;margin:10px 0 0}
.pp-alert.err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 10%,transparent);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.pp-alert.ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 12%,transparent);color:var(--dsw-alias-state-success-primary,#15803d)}
.pp-alert.info{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-secondary,#4b5563)}
.pp-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.pp-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary,#6b7280);padding:4px 8px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5);white-space:nowrap}
.pp-table td{padding:5px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1,#f2f2f2);vertical-align:top}
.pp-table tr:last-child td{border-bottom:0}
.pp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.pp-empty{padding:22px 12px;text-align:center;color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px}
.pp-step{display:flex;gap:10px;margin-bottom:12px}
.pp-step .pp-num{flex:none;width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff);font-size:12px;line-height:22px;text-align:center;font-weight:600}
.pp-step .pp-step-body{flex:1;font-size:13px;line-height:21px}
.pp-not-bundle{border:1.5px solid var(--dsw-alias-state-warning-primary,#d97706);border-radius:10px;padding:12px 14px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d97706) 8%,transparent)}
.pp-not-bundle-title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-state-warning-primary,#b45309);margin-bottom:4px}
.pp-not-bundle-detail{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary,#6b7280);word-break:break-word}
.pp-spin{display:inline-block;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:pp-spin .7s linear infinite;vertical-align:-1px;margin-right:6px}
@keyframes pp-spin{to{transform:rotate(360deg)}}
.pp-mode-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-border-l4,#c8c8c8)}
.pp-mode-dot[data-kind="single"]{background:var(--dsw-alias-state-success-primary,#16a34a)}
.pp-mode-dot[data-kind="bundle"]{background:var(--dsw-alias-button-primary-fill,#111)}
`;

  /* --------------------------------- 接口层 -------------------------------- */

  let translate = (key) => key;

  /** 带超时的 fetch。 */
  async function api(pathname, init = {}) {
    const url = (() => {
      try {
        return new URL(pathname, window.location.origin).toString();
      } catch {
        return pathname;
      }
    })();
    const controller = new AbortController();
    const slow = /\/(export|import|rollback)$/.test(pathname);
    const timer = setTimeout(() => controller.abort(), slow ? 600000 : 30000);
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`接口返回的不是 JSON（${response.status}）: ${text.slice(0, 120)}`);
      }
      if (!response.ok) {
        const error = new Error((data && (data.error || data.message)) || `${response.status} ${response.statusText}`);
        // 把服务端的错误码带出来 —— 界面据此区分"拖错文件"和"真出故障"
        if (data?.code) error.code = String(data.code);
        throw error;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('请求超时，包太大或磁盘太慢');
      if (/failed to fetch|networkerror|load failed/i.test(String(error?.message ?? ''))) {
        throw new Error(translate('errors.offline'));
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  const getStatus = () => api('/plugin-pack/status');
  const doExport = (body) => api('/plugin-pack/export', { method: 'POST', body: JSON.stringify(body) });
  const doImport = (body) => api('/plugin-pack/import', { method: 'POST', body: JSON.stringify(body) });
  // inspect 接口保留在服务端（工具/CLI 会用），界面这层不再需要它
  const doRollback = (backup) => api('/plugin-pack/rollback', { method: 'POST', body: JSON.stringify({ backup }) });
  const doBrowse = (dir, options = {}) =>
    api('/plugin-pack/browse', { method: 'POST', body: JSON.stringify({ dir, create: Boolean(options.create) }) });
  const doHotload = (pkg) => api('/plugin-pack/hotload', { method: 'POST', body: JSON.stringify({ package: pkg }) });
  const getClientStatus = (pkg) => api(`/plugin-pack/client?package=${encodeURIComponent(pkg ?? 'dsh-plugin-pack')}`);
  const doImportPlugin = (dir) => api('/plugin-pack/import-plugin', { method: 'POST', body: JSON.stringify({ dir }) });
  /** 后台任务列表（进行中 + 已完成）。 */
  const getJobs = () => api('/plugin-pack/jobs?limit=20');
  const clearJobs = () => api('/plugin-pack/jobs/clear', { method: 'POST', body: '{}' });

  /** 上传一个 zip，返回宿主落盘后的绝对路径。 */
  async function uploadZip(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await fetch(new URL('/plugin-pack/upload-zip', window.location.origin).toString(), {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`上传返回的不是 JSON（${response.status}）`);
    }
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `上传失败（${response.status}）`);
    return data;
  }

  /**
   * 上传一个拖进来的目录。
   *
   * 浏览器只给 DataTransferItem。用 webkit 的 entry API 递归读取目录结构，
   * 每个文件的 name 用它的相对路径（宿主按这个还原目录树）。
   * 不支持 entry API 时退回只读文件列表。
   */
  async function uploadDirectory(dataTransfer) {
    const entries = [];
    const items = [...(dataTransfer.items ?? [])];
    const rootName = items[0]?.webkitGetAsEntry?.()?.name ?? 'plugin';

    const readEntry = async (entry, prefix) => {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        entries.push({ rel: prefix ? `${prefix}/${file.name}` : file.name, file });
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const readBatch = () =>
        new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      // readEntries 一次最多给 100 条，要循环读到空
      for (;;) {
        const batch = await readBatch();
        if (!batch.length) break;
        for (const child of batch) {
          await readEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      }
    };

    for (const item of items) {
      const entry = item.webkitGetAsEntry?.();
      if (!entry) continue;
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        entries.push({ rel: file.name, file });
      } else if (entry.isDirectory) {
        await readEntry(entry, '');
      }
    }

    if (!entries.length) throw new Error('没读到目录内容（浏览器可能不支持目录拖放）');

    const form = new FormData();
    for (const item of entries) {
      form.append(`f:${item.rel}`, item.file, item.file.name);
    }
    const response = await fetch(new URL('/plugin-pack/upload-dir', window.location.origin).toString(), {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`上传返回的不是 JSON（${response.status}）`);
    }
    if (!response.ok || !data?.ok) throw new Error(data?.error ?? `上传失败（${response.status}）`);
    return { ...data, rootName: data.rootName ?? rootName };
  }

  /* -------------------------------- 小工具件 ------------------------------- */

  function Alert({ kind = 'info', children }) {
    return h('div', { className: `pp-alert ${kind}` }, children);
  }

  function Field({ label, hint, children }) {
    return h('div', { className: 'pp-field' }, h('label', { className: 'pp-label' }, label), children, hint ? h('span', { className: 'pp-hint' }, hint) : null);
  }

  function Check({ checked, onChange, title, hint }) {
    return h(
      'label',
      { className: 'pp-check' },
      h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
      h(
        'span',
        { className: 'pp-check-body' },
        h('span', { className: 'pp-check-title' }, title),
        hint ? h('span', { className: 'pp-hint', style: { display: 'block' } }, hint) : null,
      ),
    );
  }

  function Spinner({ label }) {
    return h('span', null, h('span', { className: 'pp-spin' }), label);
  }

  /* -------------------------------- 目录选择器 ------------------------------ */

  /**
   * 选择器。
   *
   * 目标是「不费劲」：能粘路径就直接跳、有面包屑可以跳级、能点盘符换盘、
   * 目录和 zip 一起列、上下键 + 回车就能走完。
   *
   * @param {object} props
   * @param {boolean} props.open
   * @param {string} [props.startDir]
   * @param {'dir'|'file'} [props.mode] dir=选目录（底部按钮挑当前目录），file=选 zip（点文件即选）
   * @param {(path: string) => void} props.onPick
   * @param {() => void} props.onClose
   */
  function DirPicker({ open, startDir, mode = 'file', onPick, onClose }) {
    const [state, setState] = useState({ dir: '', parent: null, ancestors: [], roots: [], items: [], error: '', selectFile: null });
    const [busy, setBusy] = useState(false);
    const [typed, setTyped] = useState('');
    const [cursor, setCursor] = useState(-1);
    /** 跳转反馈：'ok' | { error } | null。没有它用户会以为回车没生效。 */
    const [jumpState, setJumpState] = useState(null);
    /** 输入框的"基线"值：失焦时只有真改过才自动确认，避免误触发跳转。 */
    const typedBaseline = useRef('');
    const listRef = useRef(null);
    /** 这次是在选目录（导出目标 / 插件目录），还是选文件（zip）。 */
    const pickingDir = mode === 'dir';

    const load = useCallback(async (dir) => {
      setBusy(true);
      try {
        // 选导出目标时允许顺手创建新目录；找 zip 时绝不创建
        const data = await doBrowse(dir ?? '', { create: mode === 'dir' });
        setState({
          dir: data.dir,
          parent: data.parent,
          ancestors: data.ancestors ?? [],
          roots: data.roots ?? [],
          items: data.items ?? [],
          error: '',
          selectFile: data.selectFile ?? null,
        });
        setTyped(data.dir);
        typedBaseline.current = data.dir;
        setCursor(-1);
        setJumpState(null);
      } catch (error) {
        setState((prev) => ({ ...prev, error: String(error?.message ?? error) }));
      } finally {
        setBusy(false);
      }
    }, []);

    useEffect(() => {
      if (!open) return;
      load(startDir);
    }, [open, startDir, load]);

    /**
     * 输入框回车：按输入的路径直接跳（没有按钮，回车即确认）。
     *
     * 为什么单独做一层而不是直接 load()：
     *   - 空路径、与当前目录相同 —— 回车看起来"没反应"，所以要明确回话
     *   - 用户多半是粘贴一个完整路径（含文件名），要能识别"这是文件"并选中它
     */
    const doJump = useCallback(
      async (raw) => {
        const text = String(raw ?? '').trim();
        if (!text) {
          setJumpState({ error: translate('browse.jumpEmpty') });
          return;
        }
        // 已经在这个目录：明确告诉用户，而不是静默无变化
        const normalized = text.replace(/[\\/]+$/, '');
        if (normalized === state.dir.replace(/[\\/]+$/, '') && !/\.zip$/i.test(text)) {
          setJumpState({ error: translate('browse.jumpSame') });
          return;
        }
        setBusy(true);
        setJumpState(null);
        try {
          const data = await doBrowse(text, { create: mode === 'dir' });
          setState({
            dir: data.dir,
            parent: data.parent,
            ancestors: data.ancestors ?? [],
            roots: data.roots ?? [],
            items: data.items ?? [],
            error: '',
            selectFile: data.selectFile ?? null,
          });
          setTyped(data.dir);
          setCursor(-1);
          // 粘的是文件（如某个 zip）：跳到它所在目录并选中它
          if (data.selectFile) {
            const index = (data.items ?? []).findIndex((item) => item.path === data.selectFile);
            if (index >= 0) setCursor(index);
            setJumpState('ok');
            return;
          }
          setJumpState('ok');
        } catch (error) {
          setJumpState({ error: String(error?.message ?? error) });
        } finally {
          setBusy(false);
        }
      },
      [state.dir],
    );

    // 上下键移动 + 回车确认；只在选择器打开时挂
    useEffect(() => {
      if (!open) return;
      const onKey = (event) => {
        if (event.key === 'Escape') {
          onClose();
          return;
        }
        const nav = state.items;
        if (event.key === 'ArrowDown') {
          if (!nav.length) return;
          event.preventDefault();
          setCursor((prev) => (prev + 1) % nav.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          if (!nav.length) return;
          event.preventDefault();
          setCursor((prev) => (prev <= 0 ? nav.length - 1 : prev - 1));
          return;
        }
        if (event.key === 'Enter') {
          const item = cursor >= 0 ? nav[cursor] : null;
          event.preventDefault();
          if (!item) {
            // 没选中任何项：直接跳输入框里的路径
            load(typed);
            return;
          }
          // 选目录时回车 = 选定它（不是钻进去）；选文件时回车 = 进入/选定
          if (item.dir) {
            if (pickingDir) onPick(item.path);
            else load(item.path);
          } else {
            onPick(item.path);
          }
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [open, state.items, cursor, typed, load, onPick, onClose, pickingDir]);

    // 选中的项滚进视野
    useEffect(() => {
      if (cursor < 0 || !listRef.current) return;
      const node = listRef.current.querySelector(`[data-idx="${cursor}"]`);
      node?.scrollIntoView({ block: 'nearest' });
    }, [cursor]);

    if (!open) return null;

    const crumbs = state.ancestors ?? [];
    const roots = state.roots ?? [];
    const currentItem = cursor >= 0 ? state.items[cursor] : null;
    const canPickDir = pickingDir || Boolean(currentItem && currentItem.dir);

    return h(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 10060,
          background: 'rgba(0,0,0,.34)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        },
        onClick: onClose,
      },
      h(
        'div',
        {
          className: 'pp-root',
          style: {
            width: 'min(720px, 100%)',
            height: 'min(560px, 86vh)',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1,#fff)',
            borderRadius: 14,
            border: '.5px solid var(--dsw-alias-border-l3,#d5d5d5)',
            overflow: 'hidden',
          },
          onClick: (event) => event.stopPropagation(),
        },
        // 标题 + 盘符
        h(
          'div',
          { className: 'pp-bar', style: { padding: '10px 14px 0', marginBottom: 0 } },
          h('b', { style: { fontSize: 13, fontWeight: 600, flex: 'none' } }, translate(mode === 'dir' ? 'browse.titleDir' : 'browse.titleFile')),
          h(
            'div',
            { style: { display: 'flex', gap: 4, marginLeft: 'auto', flexWrap: 'wrap' } },
            roots.map((root) =>
              h(
                'button',
                {
                  key: root.path,
                  className: `pp-btn sm${state.dir.toLowerCase().startsWith(root.path.toLowerCase()) ? ' primary' : ''}`,
                  style: { padding: '2px 8px', fontSize: 11 },
                  onClick: () => load(root.path),
                  title: root.path,
                },
                root.name,
              ),
            ),
          ),
        ),
        // 路径输入框：回车即确认；点开别处（失焦）也自动确认 —— 不用记得按什么
        h(
          'div',
          { style: { padding: '8px 14px' } },
          h('input', {
            className: 'pp-input pp-mono',
            value: typed,
            placeholder: translate('browse.pathHint'),
            onChange: (event) => {
              setTyped(event.target.value);
              setJumpState(null);
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                doJump(typed);
              }
            },
            onBlur: () => {
              // 只在「值确实被改过」时才自动确认：
              // 否则点下面任何文件夹都会把光标移走、触发一次多余跳转。
              const text = String(typed ?? '').trim();
              if (!text) return;
              if (text === typedBaseline.current) return;
              doJump(text);
            },
          }),
          // 结果就地反馈：成功/失败都要说话，否则用户以为没反应
          jumpState === 'ok'
            ? h('div', { className: 'pp-hint', style: { marginTop: 4, color: 'var(--dsw-alias-state-success-primary,#15803d)' } }, translate('browse.jumpOk'))
            : null,
          jumpState && typeof jumpState === 'object'
            ? h('div', { className: 'pp-hint', style: { marginTop: 4, color: 'var(--dsw-alias-state-error-primary,#dc2626)' } }, jumpState.error)
            : null,
        ),
        // 面包屑
        h(
          'div',
          {
            style: {
              padding: '0 14px 8px',
              display: 'flex',
              gap: 2,
              flexWrap: 'wrap',
              alignItems: 'center',
              fontSize: 12,
            },
          },
          crumbs.map((crumb, index) =>
            h(
              'span',
              { key: crumb.path, style: { display: 'inline-flex', alignItems: 'center', gap: 2 } },
              index > 0 ? h('span', { className: 'pp-hint' }, '›') : null,
              h(
                'button',
                {
                  className: 'pp-btn sm',
                  style: { padding: '1px 6px', fontSize: 11, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                  onClick: () => load(crumb.path),
                  title: crumb.path,
                },
                crumb.name,
              ),
            ),
          ),
        ),
        // 列表
        h(
          'div',
          { ref: listRef, style: { flex: 1, minHeight: 160, overflow: 'auto', borderTop: '.5px solid var(--dsw-alias-border-l1,#f0f0f0)' } },
          state.error ? h(Alert, { kind: 'err' }, state.error) : null,
          busy ? h('div', { className: 'pp-empty' }, h(Spinner, { label: translate('loading') })) : null,
          !busy &&
            state.items
              // 选目录模式下不列文件：用户是在挑"导出到哪儿"，
              // 列出 .tgz/.zip 只会让人以为能选压缩包（实际会被当成目录名）。
              .filter((item) => !pickingDir || item.dir)
              .map((item, index) =>
              h(
                'div',
                {
                  key: item.path,
                  'data-idx': index,
                  className: `pp-row${cursor === index ? ' pp-row-on' : ''}`,
                  style: {
                    cursor: 'pointer',
                    background: cursor === index ? 'var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 9%,transparent))' : undefined,
                  },
                  onClick: () => {
                    // 单击只选中；进入目录要双击（选目录模式下双击也不进，
                    // 否则想把当前层某个目录当目标时永远点不到）。
                    if (item.dir) {
                      setCursor(index);
                      if (!pickingDir) return;
                      return;
                    }
                    onPick(item.path);
                  },
                  onDoubleClick: () => {
                    if (item.dir) {
                      setCursor(index);
                      load(item.path);
                    } else {
                      onPick(item.path);
                    }
                  },
                  onMouseEnter: () => setCursor(index),
                },
                h('span', { style: { flex: 'none', width: 16, opacity: 0.7 } }, item.dir ? '📁' : '📦'),
                h('span', { className: 'pp-main pp-mono', style: { fontSize: 12, wordBreak: 'break-all' } }, item.name),
                item.dir
                  ? pickingDir
                    ? h(
                        'button',
                        {
                          className: 'pp-btn sm',
                          onClick: (event) => {
                            event.stopPropagation();
                            onPick(item.path);
                          },
                        },
                        translate('browse.enter'),
                      )
                    : h(
                        'button',
                        {
                          className: 'pp-btn sm',
                          onClick: (event) => {
                            event.stopPropagation();
                            load(item.path);
                          },
                        },
                        translate('browse.open'),
                      )
                  : h('span', { className: 'pp-side' }, `${(item.size / 1048576).toFixed(1)} MiB`),
                item.dir
                  ? null
                  : pickingDir
                    ? null
                    : h(
                        'button',
                        {
                          className: 'pp-btn sm',
                          onClick: (event) => {
                            event.stopPropagation();
                            onPick(item.path);
                          },
                        },
                        '选它',
                      ),
              ),
            ),
          !busy && !state.items.length && !state.error
            ? h(
                'div',
                { className: 'pp-empty' },
                pickingDir ? '空目录（这里没有子目录）' : '空目录（这里没有子目录，也没有 zip）',
              )
            : null,
        ),
        // 底部
        h(
          'div',
          {
            style: {
              padding: '10px 14px',
              borderTop: '.5px solid var(--dsw-alias-border-l1,#eee)',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            },
          },
          h(
            'span',
            { className: 'pp-hint', style: { flex: 1 } },
            pickingDir ? '↑↓ 选择 · 回车选定该目录 · 双击进入 · Esc 关闭' : '↑↓ 选择 · 回车打开 / 选文件 · Esc 关闭',
          ),
          h(
            'button',
            {
              className: 'pp-btn',
              disabled: !state.parent,
              onClick: () => state.parent && load(state.parent),
            },
            translate('browse.up'),
          ),
          h('button', { className: 'pp-btn', onClick: onClose }, translate('browse.cancel')),
          h(
            'button',
            {
              className: 'pp-btn primary',
              onClick: () => {
                if (pickingDir) {
                  onPick(state.dir);
                  return;
                }
                const item = cursor >= 0 ? state.items[cursor] : null;
                if (item?.dir) onPick(item.path);
              },
            },
            // 选目录时，主按钮永远是「用当前这个目录」——这才是导出最常用的动作
            pickingDir ? translate('browse.pickHere') : translate('browse.pickDir'),
          ),
        ),
      ),
    );
  }

  /**
   * 拖放区：把 zip 或插件目录拖进窗口就能导入。
   *
   * 浏览器只给文件名与内容，不给绝对路径（安全限制），
   * 所以分两条路：
   *   - 拖进来的是 zip：读它的字节，交给宿主临时落盘再按整合包导入
   *   - 拖进来的是目录：用 webkit 的 entry API 拿到相对结构，交给宿主落盘成插件目录
   *
   * @param {object} props
   * @param {(file: File) => void} props.onFile
   * @param {boolean} [props.busy]
   * @param {string} [props.hint]
   */
  function DropZone({ onFile, busy = false, hint, dropRef }) {
    const [over, setOver] = useState(false);
    const [hover, setHover] = useState(false);
    const inputRef = useRef(null);

    const handleDrop = (event) => {
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      const files = [...(event.dataTransfer?.files ?? [])];
      if (!files.length) return;
      // 目录需要原始 dataTransfer 去读结构，先存下来
      if (dropRef) dropRef.current.dataTransfer = event.dataTransfer;
      // 只取第一个：一次拖一个，避免歧义
      onFile(files[0]);
    };

    return h(
      'div',
      {
        className: 'pp-drop',
        'data-over': over ? '1' : '0',
        onClick: () => !busy && inputRef.current?.click(),
        onDragEnter: (event) => {
          event.preventDefault();
          setOver(true);
        },
        onDragOver: (event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!over) setOver(true);
        },
        onDragLeave: (event) => {
          event.preventDefault();
          setOver(false);
        },
        onDrop: handleDrop,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          border: `1.5px dashed ${over ? 'var(--dsw-alias-button-primary-fill,#111)' : 'var(--dsw-alias-border-l4,#c8c8c8)'}`,
          borderColor: over ? 'var(--dsw-alias-button-primary-fill,#111)' : undefined,
          background: over
            ? 'color-mix(in srgb,var(--dsw-alias-button-primary-fill,#111) 7%,transparent)'
            : 'var(--dsw-alias-bg-layer-2,#fafafa)',
          borderRadius: 12,
          padding: '22px 16px',
          textAlign: 'center',
          cursor: busy ? 'wait' : 'pointer',
          transition: 'border-color .12s, background .12s',
          marginBottom: 14,
        },
      },
      h('div', { style: { fontSize: 24, lineHeight: '30px', marginBottom: 4, opacity: over ? 1 : 0.75 } }, over ? '📥' : '📂'),
      h(
        'div',
        { style: { fontSize: 13, fontWeight: 500 } },
        busy ? translate('drop.running') : over ? translate('drop.release') : translate('drop.title'),
      ),
      h('div', { className: 'pp-hint', style: { marginTop: 4 } }, hint ?? translate('drop.hint')),
      h('input', {
        ref: inputRef,
        type: 'file',
        accept: '.zip,.tgz,.gz,application/zip,application/gzip',
        style: { display: 'none' },
        onChange: (event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        },
      }),
    );
  }

  /**
   * 重名冲突确认弹窗。
   *
   * 导入时如果包里有已经装过的插件，先问清楚再动盘：
   *   - 每个插件单独选「覆盖 / 跳过」
   *   - 也可以一键「全部覆盖」「全部跳过」
   *   - 确认后把 { 包名: 'overwrite'|'skip' } 交回去
   *
   * @param {object} props
   * @param {object} props.pending { kind, file, conflicts }
   * @param {(decisions: object) => void} props.onConfirm
   * @param {() => void} props.onCancel
   * @param {(msg: string) => string} props.t
   */
  function ConflictDialog({ pending, onConfirm, onCancel, t }) {
    const conflicts = pending?.conflicts ?? [];
    /** 初始全部选「覆盖」——多数人是想升级到新版本。 */
    const [decisions, setDecisions] = useState(() =>
      Object.fromEntries(conflicts.map((item) => [item.name, 'overwrite'])),
    );

    // 弹窗打开时挂 Esc
    useEffect(() => {
      const onKey = (event) => {
        if (event.key === 'Escape') onCancel();
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onCancel]);

    if (!pending) return null;

    const setAll = (value) => setDecisions(Object.fromEntries(conflicts.map((item) => [item.name, value])));
    const overwriteCount = Object.values(decisions).filter((v) => v === 'overwrite').length;
    const skipCount = Object.values(decisions).filter((v) => v === 'skip').length;

    return h(
      'div',
      {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 10070,
          background: 'rgba(0,0,0,.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
        },
        onClick: onCancel,
      },
      h(
        'div',
        {
          className: 'pp-root',
          style: {
            width: 'min(640px, 100%)',
            maxHeight: '80vh',
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--dsw-alias-bg-layer-1,#fff)',
            borderRadius: 14,
            border: '.5px solid var(--dsw-alias-border-l3,#d5d5d5)',
            overflow: 'hidden',
          },
          onClick: (event) => event.stopPropagation(),
        },
        // 头部
        h(
          'div',
          { style: { padding: '12px 16px', borderBottom: '.5px solid var(--dsw-alias-border-l1,#eee)' } },
          h('b', { style: { fontSize: 14, fontWeight: 600, display: 'block', marginBottom: 4 } }, t('conflict.title')),
          h(
            'span',
            { className: 'pp-hint' },
            `${conflicts.length} ${t('conflict.subtitle')}`,
          ),
        ),
        // 一键按钮
        h(
          'div',
          { className: 'pp-bar', style: { padding: '10px 16px 0', marginBottom: 0 } },
          h('button', { className: 'pp-btn sm', onClick: () => setAll('overwrite') }, t('conflict.allOverwrite')),
          h('button', { className: 'pp-btn sm', onClick: () => setAll('skip') }, t('conflict.allSkip')),
          h(
            'span',
            { className: 'pp-hint', style: { marginLeft: 'auto' } },
            `${t('conflict.overwrite')} ${overwriteCount} · ${t('conflict.skip')} ${skipCount}`,
          ),
        ),
        // 列表
        h(
          'div',
          { style: { flex: 1, minHeight: 120, overflow: 'auto', padding: '8px 16px' } },
          conflicts.map((item) =>
            h(
              'div',
              {
                key: item.name,
                className: 'pp-row',
                style: { alignItems: 'center', gap: 12, padding: '8px 0' },
              },
              h(
                'div',
                { className: 'pp-main' },
                h(
                  'div',
                  { className: 'pp-name' },
                  item.name,
                  item.installedVersion
                    ? h('span', { className: 'pp-ver' }, `${item.installedVersion} → ${item.version}`)
                    : h('span', { className: 'pp-ver' }, item.version),
                  item.sameVersion ? h('span', { className: 'pp-ver' }, t('conflict.sameVersion')) : null,
                ),
                h('div', { className: 'pp-meta pp-mono', style: { fontSize: 11 } }, item.dest),
              ),
              // 每个插件单独选
              h(
                'div',
                { style: { display: 'flex', gap: 4, flex: 'none' } },
                h(
                  'button',
                  {
                    className: `pp-btn sm${decisions[item.name] === 'overwrite' ? ' primary' : ''}`,
                    onClick: () => setDecisions((prev) => ({ ...prev, [item.name]: 'overwrite' })),
                  },
                  t('conflict.overwrite'),
                ),
                h(
                  'button',
                  {
                    className: `pp-btn sm${decisions[item.name] === 'skip' ? ' primary' : ''}`,
                    onClick: () => setDecisions((prev) => ({ ...prev, [item.name]: 'skip' })),
                  },
                  t('conflict.skip'),
                ),
              ),
            ),
          ),
        ),
        // 底部
        h(
          'div',
          {
            style: {
              padding: '10px 16px',
              borderTop: '.5px solid var(--dsw-alias-border-l1,#eee)',
              display: 'flex',
              gap: 8,
              justifyContent: 'flex-end',
            },
          },
          h('button', { className: 'pp-btn', onClick: onCancel }, t('conflict.cancel')),
          h(
            'button',
            { className: 'pp-btn primary', onClick: () => onConfirm(decisions) },
            t('conflict.confirm'),
          ),
        ),
      ),
    );
  }

  /**
   * 后台任务条。
   *
   * 解决的问题：导出/导入要跑几十秒，切走画面结果就丢了。
   * 现在任务状态存在宿主里，切回来能继续看到进度或结果。
   *
   * @param {object} props
   * @param {object[]} props.jobs
   * @param {() => void} props.onClear
   * @param {(key: string) => string} props.t
   */
  function JobList({ jobs, onClear, t }) {
    if (!jobs.length) return null;

    const kindLabel = (kind) =>
      ({
        export: t('jobs.kindExport'),
        import: t('jobs.kindImport'),
        'import-plugin': t('jobs.kindImportPlugin'),
        rollback: t('jobs.kindRollback'),
      })[kind] ?? kind;

    const statusColor = (status) =>
      status === 'running'
        ? 'var(--dsw-alias-label-secondary,#6b7280)'
        : status === 'done'
          ? 'var(--dsw-alias-state-success-primary,#16a34a)'
          : 'var(--dsw-alias-state-error-primary,#dc2626)';

    const statusText = (status) =>
      status === 'running' ? t('jobs.running') : status === 'done' ? t('jobs.done') : t('jobs.failed');

    const fmtTime = (ms) => {
      if (!ms) return '';
      const d = new Date(ms);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const fmtSize = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)} MiB` : '');

    return h(
      'div',
      { className: 'pp-card', style: { marginBottom: 14 } },
      h(
        'div',
        { className: 'pp-bar', style: { marginBottom: 8 } },
        h('h3', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, t('jobs.title')),
        h('span', { style: { flex: 1 } }),
        h('button', { className: 'pp-btn sm', onClick: onClear }, t('jobs.clear')),
      ),
      h(
        'div',
        { className: 'pp-list' },
        jobs.map((job) =>
          h(
            'div',
            { key: job.id, className: 'pp-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4 } },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
              job.status === 'running'
                ? h('span', { className: 'pp-spin', style: { flex: 'none' } })
                : h('span', {
                    style: {
                      flex: 'none',
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: statusColor(job.status),
                    },
                  }),
              h('span', { style: { fontWeight: 500, fontSize: 13 } }, kindLabel(job.kind)),
              h('span', { className: 'pp-hint' }, job.title),
              h('span', { style: { flex: 1 } }),
              h('span', { className: 'pp-hint', style: { color: statusColor(job.status) } }, statusText(job.status)),
              h('span', { className: 'pp-hint pp-mono', style: { fontSize: 11 } }, fmtTime(job.createdAt)),
            ),
            // 进行中：进度条 + 最后一条进度
            job.status === 'running'
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    {
                      style: {
                        height: 3,
                        borderRadius: 2,
                        background: 'var(--dsw-alias-border-l1,#eee)',
                        overflow: 'hidden',
                        marginTop: 2,
                      },
                    },
                    h('div', {
                      style: {
                        width: `${Math.max(4, job.percent)}%`,
                        height: '100%',
                        background: 'var(--dsw-alias-button-primary-fill,#111)',
                        transition: 'width .3s',
                      },
                    }),
                  ),
                  job.progress?.length
                    ? h('div', { className: 'pp-hint', style: { marginTop: 2 } }, job.progress[job.progress.length - 1].message)
                    : null,
                )
              : null,
            // 完成：结果摘要
            job.status === 'done' && job.result
              ? h(
                  'div',
                  { className: 'pp-hint', style: { marginTop: 2 } },
                  [
                    job.result.file ? job.result.file : null,
                    fmtSize(job.result.bytes),
                    job.result.plugins?.length ? `${job.result.plugins.length} ${t('plugins')}` : null,
                    job.durationMs ? `${(job.durationMs / 1000).toFixed(1)}s` : null,
                  ]
                    .filter(Boolean)
                    .join(' · '),
                )
              : null,
            job.status === 'failed'
              ? h('div', { className: 'pp-hint', style: { color: 'var(--dsw-alias-state-error-primary,#dc2626)', marginTop: 2 } }, job.error ?? '')
              : null,
          ),
        ),
      ),
    );
  }

  /* --------------------------------- 主面板 -------------------------------- */

  /**
   * 主面板。
   *
   * @param {object} props
   * @param {string} [props.onlyTab] 只渲染某一个子页（插件页的「导入」「导出」标签用这个）
   */
  function Panel({ onlyTab = null } = {}) {
    const t = translate;
    const [tab, setTab] = useState(onlyTab ?? 'export');
    const [status, setStatus] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState(null);
    const [out, setOut] = useState('');
    const [includeData, setIncludeData] = useState(false);
    const [includeSecrets, setIncludeSecrets] = useState(false);
    const [dryExport, setDryExport] = useState(false);
    const [exportResult, setExportResult] = useState(null);
    const [zipPath, setZipPath] = useState('');
    const [importResult, setImportResult] = useState(null);
    const [rollbackResult, setRollbackResult] = useState(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerDir, setPickerDir] = useState('');
    const [pickerMode, setPickerMode] = useState('file');
    const [importPluginResult, setImportPluginResult] = useState(null);
    /** 待确认的重名冲突：{ kind, file, conflicts, plugins }。非空时弹窗。 */
    const [pendingImport, setPendingImport] = useState(null);
    /** 后台任务列表：切走画面回来靠它恢复 */
    const [jobs, setJobs] = useState([]);
    /** 体积上限（MiB），0 = 不限制。默认跟着服务端配置走。 */
    const [maxMb, setMaxMb] = useState(0);
    const [hotBusy, setHotBusy] = useState(false);
    const [hotResult, setHotResult] = useState(null);
    /** 拖放时的原始 DataTransfer：目录要用它的 webkitGetAsEntry 读结构。 */
    const lastDrop = useRef({ dataTransfer: null });

    const load = useCallback(async () => {
      setError('');
      setBusy(true);
      try {
        const data = await getStatus();
        setStatus(data);
        setSelected((prev) => {
          if (prev) return prev;
          const map = {};
          for (const plugin of data.plugins) map[plugin.name] = plugin.skipped !== 'not-plugin';
          return map;
        });
        setOut((prev) => prev || data.exportsDir || '');
        // 上限默认跟服务端配置；只在用户没手动改过时才覆盖
        setMaxMb((prev) => (prev === 0 ? Math.round((data.settings?.maxBytes ?? 0) / 1048576) : prev));
      } catch (err) {
        setError(String(err?.message ?? err));
      } finally {
        setBusy(false);
      }
    }, []);

    useEffect(() => {
      load();
    }, [load]);

    /* 后台任务轮询。
     * 挂载时先拉一次（切走画面回来能立刻看到上次的结果），
     * 之后有任务在跑就每 1.5 秒刷新，全跑完就停 —— 不空转。 */
    useEffect(() => {
      let alive = true;
      let timer = null;

      const tick = async () => {
        if (!alive) return;
        try {
          const data = await getJobs();
          if (!alive) return;
          setJobs(data.jobs ?? []);
          const anyRunning = (data.running ?? []).length > 0;
          if (anyRunning) timer = setTimeout(tick, 1500);
        } catch {
          // 拉失败就慢点重试，不刷屏
          if (alive) timer = setTimeout(tick, 5000);
        }
      };

      tick();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, []);

    /** 任务结束（成功或失败）后手动催一次刷新。 */
    const refreshJobs = useCallback(async () => {
      try {
        const data = await getJobs();
        setJobs(data.jobs ?? []);
      } catch {
        /* 忽略 */
      }
    }, []);

    const clearJobHistory = async () => {
      try {
        await clearJobs();
        await refreshJobs();
      } catch {
        /* 忽略 */
      }
    };

    const plugins = status?.plugins ?? [];
    const exporters = plugins.filter((plugin) => plugin.skipped !== 'not-plugin');
    const chosen = exporters.filter((plugin) => selected?.[plugin.name]);
    const chosenBytes = chosen.reduce((sum, plugin) => sum + plugin.bytes, 0);

    const toggle = (nameIn, value) => setSelected((prev) => ({ ...(prev ?? {}), [nameIn]: value }));
    const allOn = exporters.length > 0 && chosen.length === exporters.length;

    const runHotload = async () => {
      setHotBusy(true);
      setHotResult(null);
      try {
        const data = await doHotload('dsh-plugin-pack');
        setHotResult(data);
      } catch (err) {
        setHotResult({ ok: false, error: String(err?.message ?? err) });
      } finally {
        setHotBusy(false);
      }
    };

    /** 「本地导入插件」：把一个已存在的插件目录接进当前 profile。 */
    /** 拖放进来：zip/tgz 走整合包导入，目录走本地插件导入。 */
    const runDrop = async (file) => {
      setBusy(true);
      setImportResult(null);
      setImportPluginResult(null);
      try {
        const name = String(file?.name ?? '');
        // .zip = 整合包；.tgz / .tar.gz = 单个插件的 npm tarball。
        // 两者都走"上传 → 导入"，具体分流由服务端按扩展名决定。
        const isArchive = /\.(zip|tgz|tar\.gz)$/i.test(name);
        if (isArchive) {
          const uploaded = await uploadZip(file);
          setZipPath(uploaded.file);

          // 先 dryRun 探一次：有重名冲突就弹窗让用户决定
          const preview = await doImport({ file: uploaded.file, dryRun: true });
          const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts : [];
          if (conflicts.length) {
            setPendingImport({
              kind: 'bundle',
              file: uploaded.file,
              conflicts,
              plugins: preview.plugins ?? [],
            });
            setBusy(false);
            return;
          }

          const result = await doImport({
            file: uploaded.file,
            dryRun: false,
            mode: 'merge',
            restoreData: true,
            linkNodeModules: true,
          });
          setImportResult(result);
          await load();
          await refreshJobs();
        } else {
          // 目录（拖目录时浏览器的 File.name 是目录名，没有扩展名）
          const uploaded = await uploadDirectory(lastDrop.dataTransfer ?? {});
          const preview = await doImportPlugin(uploaded.dir);
          if (preview?.ok === false) {
            setImportPluginResult({ error: preview.error ?? '导入失败' });
            return;
          }
          const result = preview;
          setImportPluginResult(result);
          await load();
        }
      } catch (err) {
        const message = String(err?.message ?? err);
        const code = err?.code ? String(err.code) : null;
        if (/\.(zip|tgz|tar\.gz)$/i.test(String(file?.name ?? ''))) setImportResult({ error: message, code });
        else setImportPluginResult({ error: message, code });
      } finally {
        setBusy(false);
        lastDrop.dataTransfer = null;
      }
    };

    /** 用户在冲突弹窗里做了选择：带着 decisions 真正导入。 */
    const confirmImport = async (decisions) => {
      const pending = pendingImport;
      if (!pending) return;
      setPendingImport(null);
      setBusy(true);
      setImportResult(null);
      try {
        const result = await doImport({
          file: pending.file,
          dryRun: false,
          restoreData: true,
          linkNodeModules: true,
          decisions,
        });
        setImportResult(result);
        await load();
        await refreshJobs();
      } catch (err) {
        setImportResult({ error: String(err?.message ?? err) });
      } finally {
        setBusy(false);
      }
    };

    const runExport = async () => {
      if (!chosen.length) {
        setExportResult({ error: translate('export.empty') });
        return;
      }
      setBusy(true);
      setExportResult(null);
      try {
        const data = await doExport({
          out: out.trim(),
          include: chosen.map((plugin) => plugin.name),
          includeData,
          includeSecrets,
          dryRun: dryExport,
          // 界面上的上限优先；0 表示不限制
          maxBytes: maxMb > 0 ? Math.round(Number(maxMb) * 1024 * 1024) : 0,
        });
        setExportResult(data);
        await load();
        await refreshJobs();
      } catch (err) {
        setExportResult({ error: String(err?.message ?? err) });
      } finally {
        setBusy(false);
      }
    };

    const runRollback = async (backupName) => {
      if (!window.confirm(translate('backup.confirm'))) return;
      setBusy(true);
      setRollbackResult(null);
      try {
        const data = await doRollback(backupName);
        setRollbackResult(data);
        await load();
      } catch (err) {
        setRollbackResult({ error: String(err?.message ?? err) });
      } finally {
        setBusy(false);
      }
    };

    /* --- 渲染：头部 --- */
    const header = h(
      'div',
      null,
      h('h1', { className: 'pp-h1' }, t('title')),
      h('p', { className: 'pp-sub' }, t('subtitle')),
      h(
        'div',
        { className: 'pp-bar' },
        h('span', { className: 'pp-pill' }, t('profile'), h('b', null, status?.profile?.name ?? '—')),
        h('span', { className: 'pp-pill' }, t('plugins'), h('b', null, exporters.length)),
        h('span', { className: 'pp-pill' }, t('total'), h('b', null, status?.totals?.bytesText ?? '—')),
        h('span', { style: { flex: 1 } }),
        h(
          'button',
          { className: 'pp-btn sm', disabled: busy || hotBusy, onClick: runHotload, title: t('hotload.why') },
          hotBusy ? h(Spinner, { label: t('hotload.running') }) : t('hotload'),
        ),
        h('button', { className: 'pp-btn sm', disabled: busy, onClick: load }, busy ? h(Spinner, { label: t('loading') }) : t('refresh')),
      ),
      error ? h(Alert, { kind: 'err' }, `${t('failed')}: ${error}`) : null,
      hotResult
        ? h(
            'div',
            { style: { marginTop: 10 } },
            h(Alert, { kind: hotResult.ok ? 'ok' : 'err' },
              hotResult.ok ? t('hotload.done') : `${t('hotload.failed')}: ${hotResult.error ?? '未知原因'}`),
            hotResult.steps?.length
              ? h('div', { className: 'pp-note' }, hotResult.steps.slice(0, 8).join(' · '))
              : null,
            hotResult.rev ? h('div', { className: 'pp-hint', style: { marginTop: 4 } }, `rev=${hotResult.rev}`) : null,
          )
        : null,
    );

    /* --- 渲染：导出页 --- */
    const exportPage = h(
      'div',
      null,
      // 后台任务：导出要跑几十秒，切走画面回来还能看到进度/结果
      h(JobList, { jobs, onClear: clearJobHistory, t }),
      h(
        'div',
        { className: 'pp-card' },
        h('h3', null, t('export.title')),
        h('p', { className: 'pp-desc' }, t('export.desc')),
        // 不再让用户选"单个插件 / 整合包"：勾几个就自动是什么。
        // 勾 1 个 → 单个插件；勾多个 → 整合包。这里只把结果说出来。
        h(
          'div',
          {
            className: 'pp-hint',
            style: { marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 },
          },
          h('span', { className: 'pp-mode-dot', 'data-kind': chosen.length === 1 ? 'single' : chosen.length > 1 ? 'bundle' : 'none' }),
          chosen.length === 0
            ? t('export.scope.none')
            : chosen.length === 1
              ? `${t('export.scope.single')}：${chosen[0].name}`
              : `${t('export.scope.bundle')}（${chosen.length} 个）`,
        ),
        h(
          'div',
          { className: 'pp-bar', style: { marginBottom: 8 } },
          h('button', { className: 'pp-btn sm', onClick: () => setSelected(Object.fromEntries(exporters.map((p) => [p.name, true]))) }, t('selectAll')),
          h('button', { className: 'pp-btn sm', onClick: () => setSelected(Object.fromEntries(exporters.map((p) => [p.name, false]))) }, t('selectNone')),
          h(
            'span',
            {
              className: 'pp-hint',
              style: {
                marginLeft: 'auto',
                color: maxMb > 0 && chosenBytes > maxMb * 1048576 ? 'var(--dsw-alias-state-error-primary,#dc2626)' : undefined,
              },
            },
            `${chosen.length} / ${exporters.length} ${t('selected')} · ${(chosenBytes / 1048576).toFixed(1)} MiB` +
              (maxMb > 0 && chosenBytes > maxMb * 1048576 ? ` · ${t('export.overLimit')}` : ''),
          ),
        ),
        h(
          'div',
          { className: 'pp-list' },
          exporters.length === 0
            ? h('div', { className: 'pp-empty' }, t('backup.none'))
            : exporters.map((plugin) =>
                h(
                  'div',
                  { key: plugin.name, className: `pp-row${selected?.[plugin.name] ? '' : ' pp-dim'}` },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(selected?.[plugin.name]),
                    onChange: (event) => toggle(plugin.name, event.target.checked),
                  }),
                  h(
                    'div',
                    { className: 'pp-main' },
                    h(
                      'div',
                      { className: 'pp-name' },
                      plugin.name,
                      h('span', { className: 'pp-ver' }, plugin.version),
                      plugin.inBundles ? null : h('span', { className: 'pp-ver' }, plugin.kind === 'path' ? 'path' : 'deps-only'),
                    ),
                    h(
                      'div',
                      { className: 'pp-meta' },
                      `${plugin.files} ${t('files')} · ${t('deps')} ${plugin.deps} · ${t('patch')} ${plugin.patchRows}+${plugin.insertRows}`,
                      plugin.dataCandidates?.length ? ` · ${t('data')}: ${plugin.dataCandidates.join(', ')}` : '',
                    ),
                    plugin.warnings?.length ? h('div', { className: 'pp-warn' }, plugin.warnings.join('；')) : null,
                  ),
                  h('div', { className: 'pp-side' }, plugin.bytesText),
                ),
              ),
        ),
      ),
      h(
        'div',
        { className: 'pp-card' },
        h(
          Field,
          { label: t('export.out'), hint: t('export.outHint') },
          h(
            'div',
            { className: 'pp-input-row' },
            h('input', {
              className: 'pp-input',
              value: out,
              placeholder: status?.exportsDir ?? '',
              onChange: (event) => setOut(event.target.value),
            }),
            h(
              'button',
              {
                className: 'pp-btn',
                onClick: () => {
                  setPickerDir(out || status?.exportsDir || '');
                  setPickerMode('dir');
                  setPickerOpen(true);
                },
              },
              t('import.pick'),
            ),
          ),
        ),
        h(Check, {
          checked: includeData,
          onChange: setIncludeData,
          title: t('export.includeData'),
          hint: t('export.includeDataHint'),
        }),
        h(Check, {
          checked: includeSecrets,
          onChange: setIncludeSecrets,
          title: t('export.includeSecrets'),
          hint: t('export.includeSecretsHint'),
        }),
        h(Check, { checked: dryExport, onChange: setDryExport, title: t('export.dry') }),
        // 体积上限：你这套插件（dsh-ops 407 MiB + dsh-pet 71 MiB）本来就超过 512 MiB，
        // 所以放到界面上让用户自己调，而不是硬挡。
        h(
          Field,
          { label: t('export.maxMb'), hint: t('export.maxMbHint') },
          h(
            'div',
            { className: 'pp-input-row' },
            h('input', {
              className: 'pp-input',
              type: 'number',
              min: 0,
              step: 128,
              value: maxMb,
              style: { maxWidth: 160 },
              onChange: (event) => setMaxMb(Math.max(0, Number(event.target.value) || 0)),
            }),
            h('span', { className: 'pp-hint' }, 'MiB'),
            maxMb > 0 && chosenBytes > maxMb * 1048576
              ? h(
                  'button',
                  {
                    className: 'pp-btn sm',
                    onClick: () => setMaxMb(Math.ceil((chosenBytes * 1.15) / 1048576)),
                  },
                  t('export.maxMbFit'),
                )
              : null,
            h(
              'button',
              { className: 'pp-btn sm', onClick: () => setMaxMb(0) },
              t('export.maxMbNone'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'pp-bar', style: { marginTop: 12, marginBottom: 0 } },
          h('button', { className: 'pp-btn primary', disabled: busy, onClick: runExport }, busy ? h(Spinner, { label: t('export.running') }) : t('export.run')),
        ),
        exportResult
          ? exportResult.error
            ? h(Alert, { kind: 'err' }, exportResult.error)
            : h(
                'div',
                null,
                h(Alert, { kind: 'ok' }, exportResult.dryRun ? `${t('export.dry')} · ${exportResult.bytes ? (exportResult.bytes / 1048576).toFixed(1) : 0} MiB` : t('export.done')),
                h('div', { className: 'pp-out' }, exportResult.file),
                h(
                  'div',
                  { className: 'pp-hint', style: { marginTop: 6 } },
                  `${t('export.size')} ${(exportResult.bytes / 1048576).toFixed(1)} MiB · ${t('export.raw')} ${((exportResult.rawBytes ?? 0) / 1048576).toFixed(1)} MiB · ${t('export.entries')} ${exportResult.entries ?? 0}`,
                ),
                exportResult.warnings?.length
                  ? h('div', { className: 'pp-note' }, exportResult.warnings.slice(0, 8).join('；'))
                  : null,
                exportResult.dryRun
                  ? null
                  : h(
                      'div',
                      { className: 'pp-bar', style: { marginTop: 10, marginBottom: 0 } },
                      h(
                        'button',
                        {
                          className: 'pp-btn',
                          onClick: () => {
                            // 导入页只有拖拽框，切过去让用户把解压/包直接拖进来
                            setImportResult(null);
                            setImportPluginResult(null);
                            setTab('import');
                          },
                        },
                        `${t('import.title')} →`,
                      ),
                    ),
              )
          : null,
      ),
    );

    /* --- 渲染：导入页 ---
     * 只留一个拖拽框。zip 和插件目录都认，拖进来就开始导入，
     * 不再有「整合包 / 本地插件」页签和一堆输入框、勾选项。 */
    const importPage = h(
      'div',
      null,
      h(DropZone, { onFile: runDrop, busy, dropRef: lastDrop }),
      // 后台任务：切走画面回来能看到刚才那次导入的结果
      h(JobList, { jobs, onClear: clearJobHistory, t }),

      // 结果反馈：导完要说清楚发生了什么
      importResult
        ? importResult.error
          ? h(
              'div',
              { style: { marginTop: 10 } },
              // 「zip 不是整合包」这类是"拖错文件了"，不是系统故障，
              // 用更醒目的块单独说清楚，别和普通错误混在一起
              ['NOT_A_ZIP', 'NOT_A_BUNDLE', 'BAD_MANIFEST', 'BAD_FORMAT', 'BAD_PACK'].includes(String(importResult.code ?? '')) ||
              /不是整合包|不是有效的 zip|没有 manifest/i.test(String(importResult.error))
                ? h(
                    'div',
                    { className: 'pp-not-bundle' },
                    h('div', { className: 'pp-not-bundle-title' }, t('import.notBundle')),
                    h('div', { className: 'pp-not-bundle-detail' }, String(importResult.error)),
                  )
                : h(Alert, { kind: 'err' }, importResult.error),
            )
          : h(
              'div',
              null,
              h(
                Alert,
                { kind: 'ok' },
                importResult.dryRun
                  ? `${t('import.dry')} · ${importResult.plugins?.length ?? 0} ${t('plugins')}`
                  : `${t('import.done')} · ${t('import.restart')}`,
              ),
              importResult.plugins?.length
                ? h(
                    'table',
                    { className: 'pp-table', style: { marginTop: 8 } },
                    h('thead', null, h('tr', null, h('th', null, t('plugins')), h('th', null, 'action'), h('th', null, t('files')))),
                    h(
                      'tbody',
                      null,
                      importResult.plugins.map((plugin, index) =>
                        h(
                          'tr',
                          { key: `${plugin.name}-${index}` },
                          h('td', null, plugin.name),
                          h('td', null, plugin.action ?? ''),
                          h('td', null, String(plugin.files ?? '')),
                        ),
                      ),
                    ),
                  )
                : null,
              importResult.backup ? h('div', { className: 'pp-out' }, importResult.backup) : null,
              !importResult.dryRun
                ? h(
                    'div',
                    { className: 'pp-bar', style: { marginTop: 10, marginBottom: 0 } },
                    h('button', { className: 'pp-btn danger', onClick: () => setTab('backup') }, `${t('backup.rollback')} →`),
                  )
                : null,
            )
        : null,

      // 本地插件导入的结果（拖目录进来的那条路）
      importPluginResult
        ? importPluginResult.error
          ? h(Alert, { kind: 'err' }, importPluginResult.error)
          : h(
              'div',
              { style: { marginTop: 10 } },
              h(Alert, { kind: 'ok' }, `${t('import.plugin.done')}${importPluginResult.restartRequired ? ` · ${t('import.restart')}` : ''}`),
              h('div', { className: 'pp-out' }, importPluginResult.name ?? ''),
              importPluginResult.deps?.length
                ? h('div', { className: 'pp-hint', style: { marginTop: 6 } }, `${t('deps')}: ${importPluginResult.deps.length}`)
                : null,
            )
        : null,
    );

    /* --- 渲染：备份页 --- */
    const backupPage = h(
      'div',
      null,
      h(
        'div',
        { className: 'pp-card' },
        h('h3', null, t('backup.title')),
        h('p', { className: 'pp-desc' }, t('backup.desc')),
        status?.backups?.length
          ? h(
              'table',
              { className: 'pp-table' },
              h(
                'thead',
                null,
                h('tr', null, h('th', null, 'backup'), h('th', null, t('backup.createdAt')), h('th', null, t('backup.items')), h('th', null, '')),
              ),
              h(
                'tbody',
                null,
                status.backups.map((item) =>
                  h(
                    'tr',
                    { key: item.name },
                    h('td', { className: 'pp-mono' }, item.name),
                    h('td', { className: 'pp-mono' }, String(item.createdAt ?? '').replace('T', ' ').slice(0, 19)),
                    h('td', null, String(item.plugins)),
                    h(
                      'td',
                      null,
                      h('button', { className: 'pp-btn sm danger', disabled: busy, onClick: () => runRollback(item.name) }, busy ? t('backup.rolling') : t('backup.rollback')),
                    ),
                  ),
                ),
              ),
            )
          : h('div', { className: 'pp-empty' }, t('backup.none')),
        rollbackResult
          ? rollbackResult.error
            ? h(Alert, { kind: 'err' }, rollbackResult.error)
            : h(
                'div',
                null,
                h(Alert, { kind: 'ok' }, `${t('backup.done')} · ${t('import.restart')}`),
                rollbackResult.restored?.length
                  ? h('div', { className: 'pp-note' }, `恢复: ${rollbackResult.restored.join(', ')}`)
                  : null,
              )
          : null,
      ),
      status?.recentExports?.length
        ? h(
            'div',
            { className: 'pp-card' },
            h('h3', null, t('recent.title')),
            h(
              'div',
              { className: 'pp-list' },
              status.recentExports.map((item) =>
                h(
                  'div',
                  { key: item.path, className: 'pp-row' },
                  h('div', { className: 'pp-main' }, h('div', { className: 'pp-name pp-mono', style: { fontSize: 12 } }, item.name)),
                  h('div', { className: 'pp-side' }, `${(item.bytes / 1048576).toFixed(1)} MiB`),
                  h(
                    'button',
                    {
                      className: 'pp-btn sm',
                      disabled: busy,
                      onClick: async () => {
                        // 导入页只剩拖拽框，所以这里直接导入，不再跳页等确认
                        setBusy(true);
                        setImportResult(null);
                        try {
                          const data = await doImport({
                            file: item.path,
                            dryRun: false,
                            mode: 'merge',
                            restoreData: true,
                            linkNodeModules: true,
                          });
                          setImportResult(data);
                          await load();
                          setTab('import');
                        } catch (err) {
                          setImportResult({ error: String(err?.message ?? err) });
                          setTab('import');
                        } finally {
                          setBusy(false);
                        }
                      },
                    },
                    t('recent.import'),
                  ),
                ),
              ),
            ),
          )
        : null,
    );

    /* --- 渲染：帮助页 --- */
    const step = (num, text) =>
      h('div', { className: 'pp-step' }, h('span', { className: 'pp-num' }, num), h('div', { className: 'pp-step-body' }, text));

    const helpPage = h(
      'div',
      { className: 'pp-card' },
      h('h3', null, t('help.title')),
      step('1', t('help.step1')),
      step('2', t('help.step2')),
      step('3', t('help.step3')),
      step('4', t('help.step4')),
      h('div', { className: 'pp-note' }, t('help.note1')),
      h('div', { className: 'pp-note' }, t('help.note2')),
      h('div', { className: 'pp-note' }, t('help.note3')),
      h('div', { className: 'pp-note' }, t('help.note4')),
      h('h3', { style: { marginTop: 18 } }, t('help.advanced')),
      h('div', { className: 'pp-out' }, t('help.cmd')),
    );

    const tabs = [
      ['export', t('tab.export')],
      ['import', t('tab.import')],
      ['backup', t('tab.backup')],
      ['help', t('tab.help')],
    ];

    const body = !status && busy ? h('div', { className: 'pp-empty' }, h(Spinner, { label: t('loading') })) : h(
      'div',
      null,
      // onlyTab：插件页的「导入」「导出」标签只显示对应那一页，不显示子 tab 栏
      onlyTab
        ? null
        : h(
            'div',
            { className: 'pp-tabs' },
            tabs.map(([key, label]) =>
              h('button', { key, className: `pp-tab${tab === key ? ' on' : ''}`, onClick: () => setTab(key) }, label),
            ),
          ),
      tab === 'export' ? exportPage : tab === 'import' ? importPage : tab === 'backup' ? backupPage : helpPage,
    );

    return h(
      'div',
      { className: 'pp-root' },
      h(
        'div',
        { className: 'pp-wrap' },
        header,
        body,
        h(
          'div',
          { className: 'pp-hint', style: { marginTop: 16, paddingTop: 10, borderTop: '.5px solid var(--dsw-alias-border-l1,#eee)' } },
          `${t('profileDir')}: ${status?.profile?.dir ?? '—'}`,
        ),
      ),
      h(DirPicker, {
        open: pickerOpen,
        startDir: pickerDir,
        mode: pickerMode,
        onClose: () => setPickerOpen(false),
        onPick: (picked) => {
          setPickerOpen(false);
          if (tab === 'import') {
            // 导入页只剩拖拽框，选择器不会再往这里送文件；
            // 万一从旧路径进来，也走和拖放一样的"先探冲突"流程。
            if (pickerMode === 'dir') {
              doImportPlugin(picked)
                .then((data) => {
                  setImportPluginResult(data.ok === false ? { error: data.error ?? '导入失败' } : data);
                  return load();
                })
                .catch((err) => setImportPluginResult({ error: String(err?.message ?? err) }));
              return;
            }
            doImport({ file: picked, dryRun: true })
              .then((preview) => {
                const conflicts = Array.isArray(preview?.conflicts) ? preview.conflicts : [];
                if (conflicts.length) {
                  setPendingImport({ kind: 'bundle', file: picked, conflicts });
                  return;
                }
                return doImport({ file: picked, dryRun: false, mode: 'merge', restoreData: true, linkNodeModules: true }).then(
                  (data) => {
                    setImportResult(data);
                    return load();
                  },
                );
              })
              .catch((err) => setImportResult({ error: String(err?.message ?? err) }));
            return;
          }
          // 导出：只有选中的是「目录」才补末尾分隔符，让后端按"目录 + 自动命名"处理。
          //
          // 之前这里无条件补 `\`，导致选中 xxx.tgz 这种文件后变成 `xxx.tgz\`，
          // 后端按"末尾带分隔符 → 当目录"处理，又拼了一次默认文件名，
          // 结果在名为 xxx.tgz 的文件夹里塞了个新 zip —— 路径看着像文件其实是目录。
          // 所以带扩展名的就当文件，原样保留。
          const looksLikeFile = /\.[a-z0-9]{2,8}$/i.test(picked);
          setOut(looksLikeFile || picked.endsWith('\\') || picked.endsWith('/') ? picked : `${picked}\\`);
        },
      }),
      // 重名冲突弹窗：叠在最上层
      h(ConflictDialog, {
        pending: pendingImport,
        t,
        onConfirm: confirmImport,
        onCancel: () => setPendingImport(null),
      }),
    );
  }

  /* --------------------- 插件页顶部的两个标签页 --------------------- */

  /**
   * 「导入」标签页：本地导入插件 / 整合包。
   *
   * 复用主面板的导入子页；宿主传进来的 install/openPackage 目前用不上
   * （我们的导入走自己的整合包格式，而不是 npm 包安装），保留在 props 里不打散布局。
   */
  function ImportTab() {
    return h(Panel, { onlyTab: 'import' });
  }

  /** 「导出」标签页：导出插件包 / 整合包。 */
  function ExportTab() {
    return h(Panel, { onlyTab: 'export' });
  }

  /* ---------------------------------- 挂载 --------------------------------- */

  let panelCtx = null;

  /** 把 locale 字典绑到 translate，供全局 t() 使用。 */
  function bindTranslate(ctx) {
    if (!ctx) return;
    try {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-pack: dictionaries');
    } catch {
      /* 没有 locale 服务时退回 key 原文 */
    }
    try {
      translate = ctx.locale.bind(NS);
    } catch {
      /* 老版本没有 bind */
    }
  }

  function apply(ctx) {
    panelCtx = ctx;
    bindTranslate(ctx);

    /* 主入口：插件页「已安装」列表里点开这一行。
     * 宿主 ui-plugin-manager 只用两种 view 渲染这个插槽（读它源码确认）：
     *   { view: 'summary' }        —— 列表里那一行的简介，只有一行字的空间
     *   { view: 'page', form }     —— 点进去的详情页，这才是完整面板
     * 注意：没有 'full' 之类的第三值，判错就会渲染成空白。 */
    ctx.slots.inject('plugins.row.config', () =>
      ctx.slots.register(
        { name: 'plugins.row.config', key: 'dsh-plugin-pack#dsh-plugin-pack', locale: NS },
        (props) => {
          if (props?.t) translate = props.t;
          if (props?.view === 'summary') return h('span', null, translate('summary'));
          return h(Panel, null);
        },
      ),
    );

    /* 入口二、三：插件页顶部「已安装 / 发现」旁边加两个标签页 —— 「导入」「导出」。
     * 宿主 ui-plugin-manager 的 plugins.tab 插槽约定（读源码确认）：
     *   entries("plugins.tab") 只读 options.id 与 options.label
     *   renderSlot('plugins.tab', { install, openPackage }, { only: tab }) 只在选中时渲染
     * 所以 id 必须稳定，label 可以是函数（resolveSlotLabel 支持）。 */
    ctx.slots.inject('plugins.tab', () => {
      const disposers = [];
      disposers.push(
        ctx.slots.register(
          { name: 'plugins.tab', id: 'plugin-pack-import', order: 10, label: () => translate('tab.navImport'), locale: NS },
          (props) => {
            if (props?.t) translate = props.t;
            return h(ImportTab, null);
          },
        ),
      );
      disposers.push(
        ctx.slots.register(
          { name: 'plugins.tab', id: 'plugin-pack-export', order: 20, label: () => translate('tab.navExport'), locale: NS },
          (props) => {
            if (props?.t) translate = props.t;
            return h(ExportTab, null);
          },
        ),
      );
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 忽略 */
          }
        }
      };
    });

    /* 入口四：设置 → 插件整合包（整页，功能齐全） */
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'dsh-plugin-pack',
          order: 460,
          label: () => translate('nav'),
          locale: NS,
          inject: () => ({ t: translate }),
        },
        (props) => {
          if (props?.t) translate = props.t;
          return h(Panel, null);
        },
      ),
    );

    // 样式表
    try {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.dshPluginPack = 'true';
        style.textContent = CSS;
        document.head.append(style);
        return () => style.remove();
      }, 'dsh-plugin-pack: styles');
    } catch {
      /* 非浏览器环境（SSR/测试） */
    }
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
} });
