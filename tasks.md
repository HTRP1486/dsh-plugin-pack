# 任务：清理隐私数据并准备发布 GitHub / npm

## 隐私清理
- [x] 删除 24 个一次性调试探测脚本（暴露内部实现与端口）
- [x] 机器路径 `C:/Users/HPRR` 全部移除
- [x] 测试里的 `D:/Temp` 改成 `os.tmpdir()`
- [x] patch-text 测试改用内置 fixture，不再依赖本机 profile
- [x] 每份测试用独立临时目录（避免并行互踩）
- [x] 最终扫描：`HPRR|C:/Users|D:/Temp` 零命中

## 发布准备
- [x] 新增 `.gitignore`
- [x] 新增 `LICENSE`（MIT）
- [x] `package.json` 的 `files` 补上 `hotload.js`（否则 npm 包缺文件）
- [x] 补 `repository` / `bugs` / `homepage` 字段
- [x] `npm pack --dry-run` 确认发布清单（22 文件 / 102 kB，全是源码）

## 验证
- [x] 全量测试 162/162 通过
- [x] 门禁 PASS
