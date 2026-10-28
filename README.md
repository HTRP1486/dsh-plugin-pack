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

### 方式一：npm（推荐）

```powershell
cd $env:DSH_HOME\profiles\desktop
npm i dsh-plugin-pack
```

然后在 `profiles/desktop/package.json` 的 `dsh.profile.bundles` 里加一行：

```json
"dsh.profile": {
  "bundles": [ "...其它 bundle...", "dsh-plugin-pack" ]
}
```

重启 dsh。

### 方式二：从 GitHub 克隆

```powershell
git clone https://github.com/HTRP1486/dsh-plugin-pack.git D:\Documents\dsh-plugin-pack
cd D:\Documents\dsh-plugin-pack
node scripts\install-to-profile.mjs
```

安装脚本做三件事（幂等，可重复跑）：

1. 复制到 `profiles/desktop/local-plugins/dsh-plugin-pack`
2. 写 `dependencies`（`link:./local-plugins/dsh-plugin-pack`）和 `bundles`
3. 建 `node_modules` junction

### 方式三：让 agent 代装

把仓库路径发给 dsh 里的 agent：

> 把 D:\Documents\dsh-plugin-pack 装进当前 profile

### 装完检查

重启 dsh 后打开「插件」页，顶部应该多了 **导入** 和 **导出** 两个标签。

看不到？确认声明完整：

```powershell
node -e "const p=require('./package.json'); console.log(p.dsh.client)"
# 应输出 { platform: 'web', immediately: true, inject: [ 'slots', 'locale' ] }
```

也可以让 agent 代劳：把本目录路径给它，让它调 `plugin_pack_import` 之外的普通文件工具写这两处配置。

---

## 第一次用：三步备份，三步还原

### 备份（在旧机器上）

1. 打开「插件」页 → **导出** 标签
2. 全选插件（或只勾要带走的），选保存位置
3. 点 **开始导出** → 得到一个 `.zip`

> 插件多、体积大时可能要等 20~30 秒。期间可以切走，任务在后台跑，回来还能看到进度。

### 还原（在新机器上）

1. 装好 dsh 和本插件
2. 打开「插件」页 → **导入** 标签
3. 把那个 `.zip` **拖进框里**

拖完自动导入。遇到重名插件会弹窗问「覆盖」还是「跳过」。

### 收尾

**重启 dsh。** 插件、依赖、配置、开关全部恢复。

不放心？每次导入前都会自动备份，点「备份与回滚」能一键回到导入前的状态。

---

## 用法

### 图形界面

三个入口，内容一样：

| 入口 | 位置 |
| --- | --- |
| **导入 / 导出 标签** | 「插件」页顶部，`已安装` 和 `发现` 旁边 |
| **插件行详情** | 「已安装」列表里点 `dsh-plugin-pack` 那一行 |
| **设置页** | 设置 → 插件整合包（整页版） |

### 直接说话（agent 帮你调工具）

> 把现在的插件导出成一个整合包
> 看看这个包里有什么
> 导入 D:\backup\dsh-plugin-pack-desktop-20261028-112000.zip
> 回滚上一次导入

### 工具清单

| 工具 | 作用 |
| --- | --- |
| `plugin_pack_list` | 列出可导出的插件、依赖数、patch 行数、体积、数据目录、历史备份 |
| `plugin_pack_export` | 导出（勾 1 个得 tgz，勾多个得 zip） |
| `plugin_pack_inspect` | 读包，列出内容与警告 |
| `plugin_pack_import` | 导入（`dryRun: true` 预演） |
| `plugin_pack_rollback` | 回滚最近一次导入 |
| `plugin_pack_hotload` | 热加载客户端界面，改完代码不用重启 |
| `plugin_pack_client_status` | 查客户端界面在宿主图表里的状态，排查「装了但看不到」 |

### 斜杠命令

```
/pack list
/pack export [路径] [--include=a,b] [--exclude=a,b] [--data] [--secrets] [--dry]
/pack inspect <包路径>
/pack import <包路径> [--dry] [--skip] [--no-data] [--no-link] [--overwrite]
/pack rollback [备份名]
/pack backups
/pack hotload [包名]
/pack client [包名]
```

### 命令行（不需要 dsh 在跑）

```powershell
dsh-plugin-pack list
dsh-plugin-pack export --out D:\backup
dsh-plugin-pack inspect D:\backup\dsh-plugin-pack-desktop-20261028-112000.zip
dsh-plugin-pack import D:\backup\dsh-plugin-pack-desktop-20261028-112000.zip --dry
dsh-plugin-pack rollback
dsh-plugin-pack backups
```

没装到 PATH 时用 `node bin\dsh-plugin-pack.js <命令>`。

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
- **全链路异步**：压缩用 `deflateRaw` / `createGzip` 而不是 `*Sync`。同步版本会把整个
  事件循环卡死 —— 实测 64 MiB 同步 gzip 耗时 413ms，期间定时器一次都不触发，
  dsh 的对话等请求全部无响应。导出几百 MiB 就是好几秒的完全冻结。
- **不擅自重启**：界面只提示「重启后生效」，不替用户杀进程。

---

## 欢迎开发者

这个项目是从零手写出来的，**没有任何第三方运行时依赖**，全部只用 Node 内置模块
（`node:fs` / `node:path` / `node:zlib` / `node:crypto` / `node:module`）。
如果你对下面任何一块感兴趣，都欢迎参与。

### 最值得动手的几块

| 方向 | 现状 | 可以怎么改 |
| --- | --- | --- |
| **压缩** | `zip-stream.js` 用 `deflateRaw` 逐条压缩，`tar.js` 用 `createGzip` 流式 | 换 zstd / 并行压缩 worker；大包分片 |
| **依赖解析** | `scan.js` 按 `dependencies` 递归，跳过 peer / `@deepseek-ai/*` | pnpm workspace 协议、`peerDependencies` 可选补齐、版本冲突合并 |
| **tar 实现** | `tar.js` 手写 ustar，支持 prefix 拆分，不支持 ZIP64 / PAX | 加 PAX 长文件名、大文件（>8 GiB）支持 |
| **界面** | `client.js` 单文件 ~97 kB，全 `createElement` | 拆组件、加虚拟滚动（插件多时列表会卡） |
| **后台任务** | `jobs.js` 内存记录，保留 30 分钟 | 落盘持久化、任务取消、并发限制 |
| **导入策略** | 逐插件覆盖/跳过 | 差异预览（哪个文件会变）、版本回退、依赖冲突检查 |
| **测试** | 162 个，覆盖导出/导入/冲突/回滚/界面渲染 | 加模糊测试（畸形 zip/tgz）、跨平台 CI（Linux/macOS） |

### 开发流程

```bash
git clone https://github.com/HTRP1486/dsh-plugin-pack.git
cd dsh-plugin-pack
npm test          # 162 个测试，约 40 秒
```

### 改完怎么生效

**只改 `client.js`**（界面）——不用重启 dsh：

```powershell
node scripts\install-to-profile.mjs
# 然后在面板里点「热加载界面」，或：
dsh-plugin-pack  →  界面右上角按钮
```

热加载原理在 [`hotload.js`](hotload.js) 顶部注释里写得很细：宿主把「这个包不是客户端包」
的判定缓存在 `pkgMeta` 里且永不失效，所以要删缓存 → 标 dirty → flush → rebuilt。

**改 `lib/*.js`**（服务端）——需要重启 dsh。导出/导入这类操作走的是新起的 worker
子进程，会重新读磁盘上的模块，但工具注册和路由在启动时就固定了。

### 代码地图

```
client.js            界面（~97 kB，单文件，无 JSX）
hotload.js           客户端热加载（删缓存 + flush + rebuilt）
lib/
├── index.js         插件入口：7 个工具 + /pack 命令
├── server.js        HTTP 桥 11 个路由（/plugin-pack/*）
├── scan.js          扫描插件、依赖闭包、patch 行；60 秒缓存
├── export.js        导出：单插件 → tgz，多插件 → zip（内含 tgz）
├── import.js        导入 zip：解包、备份、落地、合并配置、回滚
├── import-tgz.js    导入 tgz：解包成 npm 包 → 走本地插件导入
├── import-plugin.js 导入本地插件目录
├── tar.js           零依赖 tar 读写（ustar + prefix 拆分）
├── zip.js           零依赖 zip 读（central directory + CRC 校验）
├── zip-stream.js    零依赖 zip 写（异步 deflate，store 已压缩条目）
├── patch-text.js    cordis.patch.yml 的块级文本处理（保留注释缩进）
├── jobs.js          后台任务记录（进度、结果、失败原因）
├── inbox.js         拖放上传：multipart 解析 + 落盘
├── util.js          文件工具 + walkTree（同步 / 异步两版）
└── home.js          DSH_HOME / profile 路径解析
```

### 提交前请确认

```bash
npm test                        # 全绿
grep -r "C:/Users" . --include=*.js --include=*.mjs   # 不该有机器路径
```

代码里**不要出现**：个人路径、token、内网地址、真实 profile 内容。
测试需要 fixture 时放 `test/fixtures/`，不要读用户机器上的真实文件。

### 欢迎的 PR 类型

- **修 bug**：尤其是导入后插件加载失败的场景（历史上出过 scoped 包名被压扁的坑）
- **加平台支持**：现在主要在 Windows 上测过，Linux / macOS 的路径处理欢迎验证
- **性能**：大包导出（GB 级）、万级文件扫描
- **界面**：交互细节、无障碍、i18n（目前只有中英）
- **文档**：某个你踩过的坑，写进 README 或注释

不欢迎的：引入运行时依赖（这个项目的卖点就是零依赖）、改包格式但不考虑向后兼容
（导入端同时支持 `@1` 和 `@2`，新格式请照这个做）。

### 遇到问题

- 提 [Issue](https://github.com/HTRP1486/dsh-plugin-pack/issues)，附上 `dsh-plugin-pack list` 的输出和错误信息
- 排查「装了但界面不显示」：先跑 `plugin_pack_client_status`，它会告你包在不在宿主图表里
- 包导入后插件报 `ERR_MODULE_NOT_FOUND`：检查 `node_modules` 里的 scoped 包是不是
  `@scope/name` 两级结构（历史 bug，见 `test/scoped-deps.test.mjs`）

---

## 许可

MIT，随便用、随便改、随便发。改了不用署名，但欢迎回来提个 PR。

如果这个工具帮你省了事，给个 Star 就是最好的感谢。

MIT
