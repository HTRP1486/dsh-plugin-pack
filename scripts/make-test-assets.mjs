/**
 * 生成两个用于测试的整合包：
 *   test-assets/pets-bundle.zip —— 内含插件（普通整合包，5 个桌宠的 tgz 在里面）
 *   test-assets/pets-links.zip  —— 链接整合包（只有来源地址，几 KB）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeZip } from '../lib/zip.js';
import { stamp } from '../lib/home.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'test-assets');

/** 链接整合包里的插件来源。 */
const SOURCES = [
  { name: 'dsh-plugin-pet', source: 'https://github.com/c-ling/dsh-plugin-pet' },
  { name: 'dsh-pet-whale', source: 'https://github.com/nzl153/dsh-pet-whale' },
  { name: 'dsh-agentic-pet', source: 'dsh-agentic-pet' },
  { name: 'dsh-whale-pet', source: 'dsh-whale-pet' },
  { name: 'dsh-desktop-pet', source: 'dsh-desktop-pet' },
];

fs.mkdirSync(OUT, { recursive: true });

// 1) 链接整合包
const manifest = {
  format: 'dsh-plugin-pack@2',
  layout: 'links',
  createdAt: new Date().toISOString(),
  note: '链接整合包：只记录插件来源地址，安装时现取最新版',
  plugins: SOURCES.map((item) => ({ name: item.name, source: item.source })),
};

const readme = [
  '这是「链接整合包」——里面没有任何插件文件，只有来源地址。',
  '',
  '用法：拖进 dsh-plugin-pack 的导入页，或填下面这个地址：',
  '  https://raw.githubusercontent.com/HTRP1486/dsh-plugin-pack/main/test-assets/pets-links.zip',
  '',
  '安装时会逐个从来源下载：',
  ...SOURCES.map((item) => `  - ${item.name}  ←  ${item.source}`),
  '',
  '好处：文件只有几 KB，装的时候现取，永远是最新版。',
  '代价：需要联网，且上游仓库删了/改名了就装不上。',
  '',
].join('\n');

const linkFile = path.join(OUT, 'pets-links.zip');
fs.writeFileSync(
  linkFile,
  writeZip([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'README.txt', data: readme },
  ]),
);
console.log(`✓ ${path.relative(ROOT, linkFile)}  ${(fs.statSync(linkFile).size / 1024).toFixed(1)} KiB`);

// 2) 普通整合包（内含插件）：复制已有那份
const source = 'D:/Documents/桌宠插件测试整合包.zip';
const bundleFile = path.join(OUT, 'pets-bundle.zip');
if (fs.existsSync(source)) {
  fs.copyFileSync(source, bundleFile);
  console.log(`✓ ${path.relative(ROOT, bundleFile)}  ${(fs.statSync(bundleFile).size / 1048576).toFixed(2)} MiB（内含 5 个插件）`);
} else {
  console.log(`! 没找到 ${source}，跳过内含插件那份`);
}

console.log('\n生成时间:', stamp());
