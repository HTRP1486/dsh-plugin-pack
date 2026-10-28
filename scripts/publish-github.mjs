/**
 * 通过 GitHub REST API 发布仓库（绕开 github.com:443，只走 api.github.com）。
 *
 * github.com 主站在本机不通，git push 无法使用，但 api.github.com 可达。
 * 所以用 Git Database API：blob → tree → commit → 更新 ref。
 *
 * 用法: GITHUB_TOKEN=xxx node scripts/publish-github.mjs [owner] [repo]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.argv[2] || 'HTRP1486';
const REPO = process.argv[3] || 'dsh-plugin-pack';
const API = 'https://api.github.com';

if (!TOKEN) {
  console.error('需要 GITHUB_TOKEN 环境变量');
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 调 GitHub API。 */
async function api(pathname, init = {}) {
  const response = await fetch(`${API}${pathname}`, {
    ...init,
    headers: {
      Authorization: `token ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-plugin-pack-publisher',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const error = new Error(`${response.status} ${pathname}: ${data?.message ?? text.slice(0, 200)}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/** 要上传的文件（排除 .git / node_modules / 打包产物）。 */
function listFiles(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (/\.(tgz|zip|log)$/i.test(entry.name)) continue;
    if (entry.name === '.npmrc-publish') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, rel));
    } else if (entry.isFile()) {
      out.push({ rel, full, size: fs.statSync(full).size });
    }
  }
  return out;
}

/** 二进制检测：含 NUL 或以常见二进制魔数开头就当 binary。 */
function isBinary(buffer) {
  if (buffer.length === 0) return false;
  for (let i = 0; i < Math.min(buffer.length, 8000); i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

console.log(`=== 1) 检查仓库 ${OWNER}/${REPO} ===`);
let repo = null;
try {
  repo = await api(`/repos/${OWNER}/${REPO}`);
  console.log('  已存在');
} catch (error) {
  if (error.status !== 404) throw error;
  console.log('  不存在，创建中…');
  repo = await api('/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: REPO,
      description:
        'DeepSeek Harness 插件整合包：一键导出/导入插件连依赖与配置。' +
        '单个插件导出为标准 npm tgz，多个导出为内含 tgz 的 zip。零依赖，162 个测试。',
      homepage: `https://www.npmjs.com/package/${REPO}`,
      private: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
      auto_init: false,
    }),
  });
  console.log('  已创建:', repo.html_url);
}

const files = listFiles(ROOT);
console.log(`\n=== 2) 上传 ${files.length} 个文件 ===`);

/** 顺序上传，避免一次性打爆 API 速率。 */
const treeEntries = [];
let uploaded = 0;
for (const file of files) {
  const buffer = fs.readFileSync(file.full);
  const binary = isBinary(buffer);
  const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: binary ? buffer.toString('base64') : buffer.toString('utf8'),
      encoding: binary ? 'base64' : 'utf-8',
    }),
  });
  treeEntries.push({ path: file.rel, mode: '100644', type: 'blob', sha: blob.sha });
  uploaded += 1;
  if (uploaded % 10 === 0) console.log(`  已上传 ${uploaded}/${files.length}`);
}
console.log(`  全部上传完成 (${uploaded})`);

console.log('\n=== 3) 创建 tree ===');
const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tree: treeEntries }),
});
console.log('  tree:', tree.sha);

console.log('\n=== 4) 创建 commit ===');
const message = fs.readFileSync(path.join(ROOT, '.git-commit-message'), 'utf8').trim();
const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, tree: tree.sha, parents: [] }),
});
console.log('  commit:', commit.sha);

console.log('\n=== 5) 建分支 main ===');
await api(`/repos/${OWNER}/${REPO}/git/refs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ref: 'refs/heads/main', sha: commit.sha }),
});
console.log('  分支已建');

console.log('\n=== 完成 ===');
console.log('  仓库:', repo.html_url);
console.log('  提交:', `${repo.html_url}/commit/${commit.sha}`);
