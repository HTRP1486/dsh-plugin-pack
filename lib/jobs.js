/**
 * 后台任务管理器。
 *
 * 解决的问题：导出/导入要跑几十秒，用户切走画面（客户端断开）时
 * 任务在宿主里照样跑完，但结果丢了 —— 切回来什么都看不到。
 *
 * 做法：
 *   1. 每个长任务登记成一条记录，有 id、状态、进度、结果
 *   2. 任务本身在宿主里同步执行（本来就不受客户端断开影响）
 *   3. 客户端可以通过 /plugin-pack/jobs 随时查：进行中、已完成、失败
 *   4. 完成的结果保留一段时间，切回画面还能看到
 *
 * 记录存在内存里（进程重启即失，这是合理的：任务本身也随进程结束）。
 *
 * @module dsh-plugin-pack/jobs
 */
import { randomUUID } from 'node:crypto';

/** 已完成任务保留多久（毫秒）。 */
const KEEP_DONE_MS = 30 * 60 * 1000;
/** 最多保留多少条。 */
const MAX_JOBS = 40;

/** @type {Map<string, object>} */
const jobs = new Map();

/** 当前的进度回调栈（支持嵌套调用）。 */
const progressStack = [];

/** 单调递增序号：同一毫秒内创建的任务也能稳定排序。 */
let sequence = 0;

/** 产出一个短 id。 */
function newId() {
  return randomUUID().slice(0, 8);
}

/** 清理过旧/过多的记录。 */
function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finished = job.status === 'done' || job.status === 'failed';
    if (finished && now - job.finishedAt > KEEP_DONE_MS) jobs.delete(id);
  }
  // 超过上限时，先删最老的已完成任务
  if (jobs.size > MAX_JOBS) {
    const finished = [...jobs.values()]
      .filter((job) => job.status === 'done' || job.status === 'failed')
      .sort((a, b) => a.seq - b.seq);
    for (const job of finished) {
      if (jobs.size <= MAX_JOBS) break;
      jobs.delete(job.id);
    }
  }
}

/**
 * 跑一个后台任务（支持同步或异步 task）。
 *
 * 异步 task 是必须的：导出要做几秒到几十秒的压缩，
 * 用同步 API 会卡死事件循环，把 dsh 的对话一起拖住。
 *
 * @param {object} options
 * @param {'export'|'import'|'rollback'|'import-plugin'} options.kind
 * @param {string} options.title 人读的标题（如 "导出 5 个插件"）
 * @param {object} [options.meta] 任意附加信息（参数摘要等）
 * @param {(report: (message: string, percent?: number) => void) => any | Promise<any>} options.task
 * @returns {Promise<{ id: string, result: any, job: object }>}
 */
export async function runJob({ kind, title, meta = {}, task }) {
  prune();
  const id = newId();
  const job = {
    id,
    kind,
    title,
    meta,
    seq: ++sequence,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    progress: [],
    percent: 0,
    result: null,
    error: null,
  };
  jobs.set(id, job);

  const report = (message, percent) => {
    job.progress.push({ at: Date.now(), message: String(message) });
    if (job.progress.length > 200) job.progress.shift();
    if (Number.isFinite(percent)) job.percent = Math.max(0, Math.min(100, Math.round(percent)));
  };

  progressStack.push(report);
  try {
    const result = await task(report);
    job.status = 'done';
    job.percent = 100;
    job.finishedAt = Date.now();
    job.result = summarizeResult(kind, result);
    job.durationMs = job.finishedAt - job.createdAt;
    return { id, result, job };
  } catch (error) {
    job.status = 'failed';
    job.finishedAt = Date.now();
    job.error = String(error?.message ?? error);
    job.durationMs = job.finishedAt - job.createdAt;
    throw error;
  } finally {
    progressStack.pop();
  }
}

/** 取当前正在跑的任务的上报函数（导出/导入内部想上报进度时用）。 */
export function currentReporter() {
  return progressStack[progressStack.length - 1] ?? (() => {});
}

/** 把任务结果压成可序列化的摘要（不要把整个 manifest 回传）。 */
function summarizeResult(kind, result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const base = {
    ok: result.ok !== false,
    kind: result.kind ?? kind,
    file: result.file ?? null,
    bytes: result.bytes ?? null,
    entries: result.entries ?? null,
    plugins: Array.isArray(result.plugins)
      ? result.plugins.map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          action: plugin.action ?? null,
          files: plugin.files ?? null,
          bytes: plugin.bytes ?? null,
        }))
      : null,
    backup: result.backup ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 10) : [],
    restartRequired: Boolean(result.restartRequired),
  };
  return base;
}

/**
 * 列出任务。
 *
 * @param {{ limit?: number, includeDone?: boolean }} [options]
 * @returns {object[]} 最新的在前
 */
export function listJobs(options = {}) {
  prune();
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.min(100, options.limit) : 20;
  const includeDone = options.includeDone !== false;
  return [...jobs.values()]
    .filter((job) => includeDone || job.status === 'running')
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map(publicJob);
}

/** 取单个任务。 */
export function getJob(id) {
  const job = jobs.get(String(id ?? ''));
  return job ? publicJob(job) : null;
}

/** 是否有正在跑的任务。 */
export function runningJobs() {
  return [...jobs.values()].filter((job) => job.status === 'running').map(publicJob);
}

/** 转成对外结构（去掉内部字段）。 */
function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    meta: job.meta,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs ?? null,
    percent: job.percent,
    // 只回最近 12 条进度，避免响应过大
    progress: job.progress.slice(-12),
    result: job.result,
    error: job.error,
  };
}

/** 清空已完成任务（界面上的"清空记录"用）。 */
export function clearFinished() {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (job.status === 'done' || job.status === 'failed') {
      jobs.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** 测试用：清空全部。 */
export function resetJobs() {
  jobs.clear();
  progressStack.length = 0;
}
