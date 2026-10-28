/**
 * 把 dsh-plugin-pack 安装进真实 profile：
 * 1. 复制到 local-plugins/
 * 2. package.json 写 dependencies(link:) + bundles
 * 3. node_modules 建 junction
 *
 * 用法: node scripts/install-to-profile.mjs [profileDir]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const source = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const profileDir = path.resolve(
  process.argv[2] || process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
);
const dest = path.join(profileDir, 'local-plugins', 'dsh-plugin-pack');

// 1) 复制本体（跳过 test / scripts / .git）
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(source, dest, {
  recursive: true,
  dereference: true,
  filter: (src) => {
    const rel = path.relative(source, src);
    if (!rel) return true;
    if (rel.startsWith('test') || rel.startsWith('scripts') || rel.startsWith('.git')) return false;
    return true;
  },
});
console.log('copied ->', dest);

// 2) package.json
const pkgFile = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.dependencies = pkg.dependencies ?? {};
pkg.dependencies['dsh-plugin-pack'] = 'link:./local-plugins/dsh-plugin-pack';
pkg.dsh = pkg.dsh ?? {};
pkg.dsh.profile = pkg.dsh.profile ?? {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? [];
if (!pkg.dsh.profile.bundles.includes('dsh-plugin-pack')) {
  // 官方 bundles 保持在前，插件追加到末尾
  pkg.dsh.profile.bundles.push('dsh-plugin-pack');
}
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
console.log('package.json updated, bundles =', pkg.dsh.profile.bundles.length, 'entries');

// 3) junction
const link = path.join(profileDir, 'node_modules', 'dsh-plugin-pack');
try { fs.lstatSync(link); fs.rmSync(link, { recursive: true, force: true }); } catch { /* 不存在 */ }
fs.symlinkSync(dest, link, 'junction');
console.log('junction ->', fs.readlinkSync(link));

// 4) 冒烟：宿主同款入口解析
const pkg2 = JSON.parse(fs.readFileSync(path.join(link, 'package.json'), 'utf8'));
console.log('smoke: resolved via node_modules =', pkg2.name, pkg2.version);
