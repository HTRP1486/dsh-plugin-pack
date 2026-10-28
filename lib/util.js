/**
 * 文件系统小工具：只做本插件需要的那几件事，不引第三方依赖。
 *
 * @module dsh-plugin-pack/util
 */
import fs from 'node:fs';
import path from 'node:path';

/** 同步读 JSON，失败返回 fallback。 */
export function readJson(file, fallback = null) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 同步读文本，失败返回 fallback。 */
export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** 写 JSON，保持 2 空格缩进 + 末尾换行。 */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 写文本（保证父目录存在）。 */
export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

/**
 * mkdir -p。
 *
 * 已存在的目录直接返回：对盘符根（D:\）调用 mkdirSync 会抛 EPERM，
 * 因为 Windows 不允许"创建"一个已经存在的 root。
 */
export function ensureDir(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) return;
  } catch {
    /* 不存在，往下创建 */
  }
  fs.mkdirSync(dir, { recursive: true });
}

/** 存在且是文件。 */
export function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 存在且是目录（跟随符号链接）。 */
export function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** realpath，失败时原样返回。 */
export function realOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    try {
      return fs.realpathSync(target);
    } catch {
      return target;
    }
  }
}

/** 递归删除，不存在不报错。 */
export function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* 被占用时留给调用方处理 */
  }
}

/** 递归复制（跟随符号链接，pnpm 的 store 链接需要这个）。 */
export function copyTree(from, to, { filter } = {}) {
  ensureDir(path.dirname(to));
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    force: true,
    errorOnExist: false,
    filter: filter
      ? (src) => filter(src)
      : undefined,
  });
}

/** 目录体积与文件数（同步版，仅用于短的/测试路径）。 */
export function measureTree(root, options = {}) {
  let bytes = 0;
  let files = 0;
  for (const item of walkTree(root, options)) {
    bytes += item.size;
    files += 1;
  }
  return { bytes, files };
}

/**
 * 目录体积与文件数（异步版）。
 *
 * 扫描插件目录动辄上万个文件，同步版会把事件循环卡住好几秒，
 * dsh 的对话等请求一起无响应 —— 所以导出/扫描路径必须走这个。
 */
export async function measureTreeAsync(root, options = {}) {
  let bytes = 0;
  let files = 0;
  for await (const item of walkTreeAsync(root, options)) {
    bytes += item.size;
    files += 1;
  }
  return { bytes, files };
}

/**
 * 遍历目录下所有文件（异步）。
 *
 * 为什么异步：导出要遍历上万个文件，`readdirSync` + `statSync` 会把
 * 事件循环卡住好几秒，dsh 的对话等请求跟着无响应。
 * 这里全部用 fs.promises，并在每个目录之间主动让出一次。
 *
 * @param {string} root
 * @param {{ skipDirs?: Set<string>, keepFile?: (name: string) => boolean }} [options]
 * @returns {AsyncGenerator<{ path: string, rel: string, name: string, size: number }>}
 */
export async function* walkTreeAsync(root, options = {}) {
  const skipDirs = options.skipDirs ?? new Set();
  const keepFile = options.keepFile ?? (() => true);
  const stack = [{ dir: root, rel: '' }];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;

      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stat = await fs.promises.stat(full);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
          if (isDir && skipDirs.has(entry.name)) continue;
          if (isDir) {
            stack.push({ dir: full, rel });
            continue;
          }
          if (isFile && keepFile(entry.name)) {
            yield { path: full, rel, name: entry.name, size: stat.size };
          }
        } catch {
          continue;
        }
        continue;
      }

      if (isDir) {
        if (skipDirs.has(entry.name)) continue;
        stack.push({ dir: full, rel });
        continue;
      }
      if (isFile) {
        if (!keepFile(entry.name)) continue;
        let size = 0;
        try {
          size = (await fs.promises.stat(full)).size;
        } catch {
          size = 0;
        }
        yield { path: full, rel, name: entry.name, size };
      }
    }
    // 每个目录之间让出一次事件循环，避免长时间占用
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * 遍历目录下所有文件（同步版）。
 *
 * @param {string} root
 * @param {{ skipDirs?: Set<string>, keepFile?: (name: string) => boolean }} [options]
 *   keepFile 返回 true 表示保留该文件（默认全保留）；skipDirs 命中的目录整棵跳过。
 * @returns {Generator<{ path: string, rel: string, name: string, size: number }>}
 */
export function* walkTree(root, options = {}) {
  const skipDirs = options.skipDirs ?? new Set();
  const keepFile = options.keepFile ?? (() => true);
  const stack = [{ dir: root, rel: '' }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (skipDirs.has(entry.name)) continue;
          stack.push({ dir: full, rel });
        } else if (stat.isFile()) {
          if (!keepFile(entry.name)) continue;
          yield { path: full, rel, name: entry.name, size: stat.size };
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        stack.push({ dir: full, rel });
        continue;
      }
      if (entry.isFile()) {
        if (!keepFile(entry.name)) continue;
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {
          size = 0;
        }
        yield { path: full, rel, name: entry.name, size };
      }
    }
  }
}

/** 目录名是否落在排除名单里。 */
export const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.turbo',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.nyc_output',
]);

/** 永远不打包的文件。 */
export function skipAlways(name) {
  return (
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.endsWith('.log') ||
    name.endsWith('.tsbuildinfo')
  );
}

const SECRET_NAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  'credentials.json',
  'auth.json',
  'secrets.json',
  'token.json',
  'id_rsa',
  'id_ed25519',
]);

const SECRET_SUFFIX = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.token', '.secret'];

/** 疑似密钥/凭证。默认不打包，除非用户显式 includeSecrets。 */
export function looksSecret(name) {
  const lower = name.toLowerCase();
  if (SECRET_NAMES.has(lower)) return true;
  if (lower.startsWith('.env.')) return true;
  return SECRET_SUFFIX.some((suffix) => lower.endsWith(suffix));
}

/** 组合出当前场景下的文件过滤器：返回 true = 保留（可打包/可复制）。 */
export function fileFilter({ includeSecrets = false } = {}) {
  return (name) => {
    if (skipAlways(name)) return false;
    if (!includeSecrets && looksSecret(name)) return false;
    return true;
  };
}

/** 把字符串安全写入文件名。 */
export function slug(value) {
  return String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'plugin';
}
