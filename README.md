# dsh-plugin-pack

[![npm](https://img.shields.io/npm/v/dsh-plugin-pack)](https://www.npmjs.com/package/dsh-plugin-pack)
[![license](https://img.shields.io/npm/l/dsh-plugin-pack)](LICENSE)

DeepSeek Harness 的**插件整合包**工具：把当前 profile 里装的所有第三方插件，连运行时依赖和 `cordis.patch.yml` 配置，一键打成一个 zip；换机器、换 profile 时拖进去就能还原。

**有图形界面**——不用记命令，点几下就完成。桌面客户端和 Web 端都能用。

```bash
npm i dsh-plugin-pack
```

或者直接克隆：

```bash
git clone https://github.com/HTRP1486/dsh-plugin-pack.git
```

零依赖，只用 Node 内置模块。162 个测试。

---

## 界面在哪（不用敲命令）

装好重启 dsh 后，入口就在「插件」页里：

```
插件页
├ 已安装  │ 发现    ← 宿主原有
├ 导入              ← 本插件加的
└ 导出              ← 本插件加的
```

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| **导入标签页** | 插件页顶部「导入」 | 两个来源：**整合包**（zip）/ **本地插件**（本机目录） |
| **导出标签页** | 插件页顶部「导出」 | 两个范围：**单个插件**（分享用）/ **整合包**（全量备份） || **插件行详情** | 「已安装」里点 `dsh-plugin-pack` 那一行 | 同一套面板，含备份回滚与说明 |
| 设置页 | 设置 → **插件整合包** | 同上，整页版 |

> 「已安装 / 发现」旁边那两个标签页是本插件用宿主 `plugins.tab` 插槽注册的。

> 如果「插件」列表里看得到 `dsh-plugin-pack` 但点开是空白的，那是客户端 bundle 没加载成功。
> 排查顺序：① `package.json` 里要有 `exports["./client"]`；② `client.js` 要在包根目录；
> ③ 改完点面板里的「热加载界面」即可，不必重启。

每个页面做什么：

```
导入
导入（只有一个拖拽框，按扩展名自动分流）
├ .zip / .tgz / .tar.gz  拖进来即导入
└ 插件文件夹               拖进来按本地插件导入

导出（勾选数量自动决定类型）
├ 勾 1 个 → .tgz（npm tarball，别人能 npm i ./dsh-pet-0.3.8.tgz）
└ 勾多个 → .zip（整合包：插件 + 依赖 + 配置）

另含：备份与回滚（每次导入的快照，一键还原）、怎么用（四步说明）
```

### 导出格式：单个插件 vs 整合包

| | 单个插件 `.tgz` | 整合包 `.zip` |
| --- | --- | --- |
| 结构 | `package/` 下是一个标准 npm 包 | `packages/<插件>/` + `node_modules/` + `manifest.json` |
| 能给别人 | ✅ `npm i ./x.tgz` 直接可用 | 只能由本插件还原 |
| 含依赖 | ✅ 扁平化进 `package/node_modules/` | ✅ |
| 含配置 | 只含插件自带的 | ✅ 含 `cordis.patch.yml` 里属于它的行 |

两种格式都经过交叉验证：系统 `tar` 可解开，`npm install` 可安装。

### 选择器怎么用（导出/导入都用它）

| 动作 | 效果 |
| --- | --- |
| 顶部盘符按钮 | 直接换到 C:\ D:\ |
| 输入框粘路径 + 回车 | 跳到那个目录；粘一个 zip 会跳到它的目录并选中它 |
| 面包屑 | 点任意一级跳回去 |
| **单击**文件夹 | 选目录模式下：**只选中**，不进入 |
| **双击**文件夹 | 进入该文件夹 |
| 行尾「选它 / 进入」按钮 | 选目录时是「选它」，否则是「进入」 |
| 底部主按钮 | 选目录时固定是**用当前这个目录**——导出最常用的动作 |
| ↑↓ / 回车 / Esc | 键盘全程可用 |

### 给不懂技术的人的三句话

1. 点「插件」→ 顶部「导出」标签，全选，点**开始导出**，得到一个 zip。
2. 把 zip 拷到新电脑，点「插件」→「导入」，把它**拖进那个框**里。
3. **重启 dsh**。插件、依赖、配置全部照原样回来。

界面上的事，跟 `/pack` 命令完全等价——不会因为用了界面而少做任何一步。

---

## 热加载（改完不用重启）

普通插件改一行客户端代码就得重启 dsh。这个插件把它变成了一个按钮。

**三种触发方式**（等价）：

```
界面：面板右上角「热加载界面」按钮
命令：/pack hotload
工具：plugin_pack_hotload({ package: 'dsh-plugin-pack' })
```

### 为什么需要它

读宿主 `dsh-client-modules` 源码后确认的机制：

1. 宿主启动时扫描 Loader 行 → 读 `package.json` → 判定 `dsh.client.platform === 'web'`
   且 `exports["./client"]` 存在 → 才把包收进客户端图表，之后
   `/plugins/??<id>/client.js&rev=<hash>` 才有内容（否则 404）。
2. 判定结果——**包括"不是客户端包"这种否定结论**——缓存在
   `pkgMeta: Map<sourceKey, meta|null>` 里，`resolveMeta()` 命中缓存就直接返回，
   **从不重读 `package.json`，也没有失效机制**。
3. 唯一能把改动送进图表的是 `rebuilt(id)`，但它只对已在 `table` 里的包有效。
4. `dirty: Set<entryName>` + `flush(onError)` 是重扫入口，走到
   `processOne → resolveSource → resolveMeta` 会**再判定一次**。

所以热加载 = **删缓存 + 标记 dirty + flush + rebuilt**，全在宿主进程内完成。

### 附加行为

- **启动自愈**：插件启动时会自己热加载一次（`selfHotload: true`）。如果你是在装好之后
  才补 `exports["./client"]` 的，宿主缓存里的旧判定会在启动 1.2 秒后被自动纠正。
- **幂等**：已在图表里就跳过，不重复解析。
- **如实报错**：bundle 文件缺失、`platform` 不是 `web`、缺 `exports["./client"]`
  这三种情况分别给出明确原因，不假装成功。
- **只影响客户端**：服务端工具与 `/plugin-pack/*` 路由本来就是热生效的。

### 边界

热加载**只管客户端 bundle**。以下改动仍然需要重启 dsh：

- `cordis.patch.yml` 里新增/删除 Loader 行（新增一个插件）
- 插件服务端入口 `lib/index.js` 的代码
- `package.json` 的 `dsh.bundle.patch` 路径

---

## 后台任务（切走画面不丢进度）

导出/导入要跑几十秒。**任务本身跑在宿主进程里，切走画面不会中断** ——
浏览器的 `fetch` 断掉只是"不等结果了"，宿主照样把文件写完。

真正的问题是**结果会丢**：面板重新挂载，之前那次导出的路径、体积全没了。
所以加了任务记录：

```
┌ 后台任务 ─────────────────────────────── [清空已完成] ┐
│ ● 导出   导出 5 个插件        已完成  15:43:21        │
│   D:\backup\dsh-plugin-pack-desktop-20261028.zip       │
│   · 165.8 MiB · 5 插件 · 24.4s                         │
│                                                        │
│ ◐ 导出   导出全部插件         进行中  15:58:10        │
│   ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░  52%                           │
│   正在打包 dsh-ops → dsh-ops-0.4.1.tgz                │
└────────────────────────────────────────────────────────┘
```

- **切走再回来**：任务列表还在，进行中的继续显示进度，已完成显示结果
- **进行中**：每 1.5 秒自动刷新，跑完就停（不空转）
- **进度**：后端在关键节点上报（读包 → 解包 → 写配置 → 建链接）
- **保留 30 分钟 / 最多 40 条**，超了自动清理
- **结果摘要**不含 manifest 等大对象，接口响应很小

任务记录存在内存里，进程重启即清 —— 任务本身也随进程结束，这是合理的。

### 接口

```
GET  /plugin-pack/jobs            列出任务（jobs + running）
GET  /plugin-pack/jobs?id=37a1159f  查单个任务
POST /plugin-pack/jobs/clear      清空已完成记录
```

每次导出/导入的响应里也会带 `jobId`。

---

## 它解决什么问题

dsh 的插件散在三处：

| 位置 | 内容 |
| --- | --- |
| `profiles/<name>/package.json` | `dependencies` 版本声明 + `dsh.profile.bundles` 加载顺序 |
| `profiles/<name>/node_modules/` | 插件本体 + 各自的运行时依赖（pnpm 符号链接） |
| `profiles/<name>/cordis.patch.yml` | 每个插件的 config 覆盖（模型、强度、开关、路径） |

手工迁移要同时搬这三处，漏一处就是「插件装上了但配置没了」或者「配置在但包没装」。这个插件把它们当一个整体处理。

---

## 安装

```powershell
# 1. 放进 profile 的本地插件目录
Copy-Item -Recurse D:\Documents\dsh-plugin-pack "$env:DSH_HOME\profiles\desktop\local-plugins\dsh-plugin-pack"

# 2. 让 profile 认识它（等价于 pnpm add link:）
#    在 profiles/desktop/package.json 的 dependencies 里加：
#      "dsh-plugin-pack": "link:./local-plugins/dsh-plugin-pack"
#    在 dsh.profile.bundles 数组里加：
#      "dsh-plugin-pack"

# 3. 建 node_modules 链接（或直接 pnpm install）
# 4. 重启 dsh
```

也可以让 agent 代劳：把本目录路径给它，让它调 `plugin_pack_import` 之外的普通文件工具写这两处配置。

---

## 用法

### 在 dsh 里（推荐，两种都行）

**图形界面**：设置 → 插件整合包（或右下角浮动按钮）。见上面的界面说明。

**直接说话**（agent 会调工具）：

> 把现在的插件导出成一个整合包
> 看看这个包里有什么
> 导入 D:\Downloads\dsh-plugin-pack-desktop-20261026-145723.zip

工具清单：

| 工具 | 作用 |
| --- | --- |
| `plugin_pack_list` | 列出可导出的插件、依赖数、patch 行数、体积、可选数据目录、历史备份 |
| `plugin_pack_export` | 导出整合包 |
| `plugin_pack_inspect` | 读包，列出内容与警告（导入前先看） |
| `plugin_pack_import` | 导入（支持 `dryRun` 预演） |
| `plugin_pack_rollback` | 回滚最近一次导入 |

### 斜杠命令

```
/pack list
/pack export [路径] [--include=a,b] [--exclude=a,b] [--data] [--secrets] [--dry]
/pack inspect <zip>
/pack import <zip> [--dry] [--skip] [--no-data] [--no-link] [--overwrite]
/pack rollback [备份名]
/pack backups
```

### 命令行（不需要 dsh 在跑）

```powershell
node D:\Documents\dsh-plugin-pack\bin\dsh-plugin-pack.js list
node D:\Documents\dsh-plugin-pack\bin\dsh-plugin-pack.js export --out D:\backup
node D:\Documents\dsh-plugin-pack\bin\dsh-plugin-pack.js inspect D:\backup\dsh-plugin-pack-desktop-20261026-145723.zip
node D:\Documents\dsh-plugin-pack\bin\dsh-plugin-pack.js import D:\backup\dsh-plugin-pack-desktop-20261026-145723.zip --dry
node D:\Documents\dsh-plugin-pack\bin\dsh-plugin-pack.js rollback
```

---

## 整合包里有什么

```
manifest.json                          # 插件元数据、patch 行、来源 profile
README.txt                             # 人读的清单
packages/<插件名>/...                   # 插件本体（跳过 .git / node_modules）
packages/<插件名>/node_modules/<依赖>/   # 扁平化的运行时依赖
data/<插件名>/<数据目录>/...             # 可选，--data 才有
```

- **依赖闭包**：从插件 `package.json` 的 `dependencies` 递归解析，跳过 `peerDependencies`、`@deepseek-ai/*`、`@types/*`。pnpm 的符号链接会被 dereference 成真实文件。
- **patch 行**：从 `cordis.patch.yml` 里按包名/绝对路径匹配出属于该插件的行，分两类保存：
  - 顶层 row（`- id: dsh-pet` + `config:`）——导入后原样追加到顶层，保持「按 id 覆盖」语义；
  - insert 子行（`- insert:` 下面的 `- id:`）——导入时重新包成 `- insert:` 块。
- **路径插件**：`cordis.patch.yml` 里写死 `name: 'D:/Documents/dsh-pwsh7-preference/index.js'` 的插件（比如 `pwsh7-preference`）也会被识别、打包，导入时把绝对路径改回包名。

默认**不打包**：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`credentials.json`、`auth.json`、`.npmrc`、`.netrc` 等凭证文件；以及 `.git`、`node_modules`（依赖走闭包单独收）、`*.log`、`.cache`。

要带上凭证：`--secrets`（想清楚再开，包是要传出去的）。

---

## 导入做了什么

1. **预检**：读 `manifest.json`，校验格式和每个插件的 `package.json`。
2. **备份**（在 `profiles/<name>/.plugin-backups/plugin-pack-<时间戳>/`）：
   - `package.json`
   - `cordis.patch.yml`
   - 被覆盖的插件目录
   - `record.json`（回滚依据）
3. **落地**：插件解到 `profiles/<name>/local-plugins/<插件名>/`（scoped 包名压成 `@scope__name` 单层目录）。
4. **写回配置**：
   - `dependencies[<插件名>] = "link:./local-plugins/<插件名>"`
   - `dsh.profile.bundles` 追加缺失的插件名
   - `cordis.patch.yml` 追加缺失的 patch 行（同 id 默认不覆盖，`--overwrite` 才覆盖）
5. **建链接**：`node_modules/<插件名>` → `local-plugins/<插件名>`（Windows 用 junction，不需要管理员权限）。原来指向别处的链接或实体目录会先备份再替换。
6. **数据目录**：包里带 `data/` 时还原到 `$DSH_HOME/<目录>`，已存在的文件不覆盖。
7. **提示重启**。

任何一步失败都不会静默：失败项写进报告，`record.json` 仍然落盘，可以回滚。

---

## 回滚

```powershell
/pack rollback                    # 最近一次
/pack rollback plugin-pack-20261026-145723
```

恢复 `package.json`、`cordis.patch.yml`、被覆盖的插件目录，删掉本次新增的插件和链接。**重启 dsh 生效。**

---

## 注意事项

- **体积**：带原生二进制的插件（如 `sherpa-onnx-node`）会让包变得很大。默认上限 512 MiB，用 `--include` 只挑需要的插件，或调 `maxBytes`。
- **内存**：打包时所有文件会进内存，峰值约为包体积的 2 倍。几百 MB 以内没问题。
- **重启**：插件树是启动时组装的，导入/回滚后必须重启 dsh。
- **pnpm**：如果之后跑了 `pnpm install`，`link:` 依赖会被重建，不影响；但如果插件目录被删了，链接会断。
- **跨平台**：包本身是平台无关的 zip，但依赖里的原生二进制（`.node` / `.exe`）是平台相关的。Windows 导出的包导到 Linux 上，带原生模块的插件会加载失败——这类插件建议在目标平台重装。
- **密钥**：默认剔除凭证文件，但插件把 token 存在 `config` 或数据目录里的情况无法自动识别。分享包之前 `plugin_pack_inspect` 看一眼 `manifest.json` 的 patch 行。

---

## 开发

```powershell
node --test D:\Documents\dsh-plugin-pack\test\
```

模块职责：

| 文件 | 职责 |
| --- | --- |
| `client.js` | **客户端界面**（设置页 + 浮动面板，React 组件，无 JSX 编译） |
| `lib/server.js` | **HTTP 桥**：`/plugin-pack/*` 九个路由，供界面调用 |
| `lib/zip.js` | 零依赖 zip 读（deflate/store，只依赖 `node:zlib`） |
| `lib/zip-stream.js` | 流式 zip 写：逐个文件落盘，555 MiB 级大包不爆内存 |
| `lib/patch-text.js` | `cordis.patch.yml` 的块级文本处理（保留注释与缩进） |
| `lib/scan.js` | 扫描插件、依赖闭包、patch 行、数据目录 |
| `lib/export.js` | 组装 manifest + 文件树 → zip |
| `lib/import.js` | 解包、备份、落地、合并配置、回滚 |
| `lib/index.js` | 工具注册 + `/pack` 命令 + 路由挂载 |
| `bin/dsh-plugin-pack.js` | 脱离宿主的 CLI |

### 界面为什么这么设计

- **客户端拿不到文件系统**：所有真实操作都在宿主侧，界面只调 `/plugin-pack/*` 接口。
- **不用 JSX 编译**：`client.js` 是一个 `window.__ModuleLoader__.load({ factory })` 包装，
  内部 `require('react')` 后全用 `react.createElement`，宿主加载时不需要任何构建步骤。
- **不一次读整个包**：导出用 `writeZipStream` 逐条写盘；导入用 `readZipMeta` 只读中央目录，
  再逐条 `extractEntry`。555 MiB 的包峰值内存只有单个文件那么大。
- **不擅自重启**：界面只提示「重启后生效」，不替用户杀进程。

---

MIT
