/**
 * 后台任务管理器。
 *
 * 要回答的问题：导出/导入跑几十秒，用户切走画面（客户端断开），
 * 任务会不会中断？结果还找得回来吗？
 *
 * 实测结论（已在真实 dsh 上验证）：任务本身跑在宿主里，客户端断开不影响它。
 * 但结果原本会丢 —— 这个模块就是补上"结果可查"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { runJob, listJobs, getJob, runningJobs, clearFinished, resetJobs, currentReporter } from '../lib/jobs.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-jobs-suite');

test('任务记录：成功时状态变 done，结果被摘要化', async () => {
  resetJobs();
  const { id, job } = await runJob({
    kind: 'export',
    title: '导出 2 个插件',
    meta: { include: ['a', 'b'] },
    task: (report) => {
      report('开始', 10);
      report('打包中', 50);
      return { ok: true, file: 'D:/x.zip', bytes: 1024, entries: 5, plugins: [{ name: 'a', version: '1.0.0' }] };
    },
  });

  assert.ok(id);
  assert.equal(job.status, 'done');
  assert.equal(job.percent, 100);
  assert.ok(job.finishedAt >= job.createdAt);
  assert.ok(job.durationMs >= 0);
  assert.equal(job.progress.length, 2);
  assert.equal(job.result.file, 'D:/x.zip');
  assert.equal(job.result.bytes, 1024);

  const fetched = getJob(id);
  assert.equal(fetched.status, 'done');
  assert.equal(fetched.title, '导出 2 个插件');
  assert.deepEqual(fetched.meta, { include: ['a', 'b'] });
});

test('任务失败：状态 failed，错误信息保留，异常继续抛给调用方', async () => {
  resetJobs();
  let caught = null;
  try {
    await runJob({
      kind: 'import',
      title: '导入',
      task: () => {
        throw new Error('磁盘满了');
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '异常应抛给调用方');
  assert.equal(caught.message, '磁盘满了');

  const jobs = listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'failed');
  assert.equal(jobs[0].error, '磁盘满了');
});

test('listJobs 按时间倒序，最新的在前', async () => {
  resetJobs();
  const first = await runJob({ kind: 'export', title: 'first', task: () => ({ ok: true }) });
  const second = await runJob({ kind: 'import', title: 'second', task: () => ({ ok: true }) });

  const jobs = listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].title, 'second', '最新的应在前');
  assert.equal(jobs[1].title, 'first');
});

test('runningJobs 只返回进行中的', async () => {
  resetJobs();
  await runJob({ kind: 'export', title: 'done-one', task: () => ({ ok: true }) });

  // 手动塞一个"进行中"的记录
  const jobs = listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(runningJobs().length, 0, '完成的任务不算 running');
});

test('进度上报：最后一条可在列表里看到', async () => {
  resetJobs();
  await runJob({
    kind: 'export',
    title: '带进度',
    task: (report) => {
      for (let i = 0; i <= 10; i += 1) report(`第 ${i} 步`, i * 10);
      return { ok: true };
    },
  });

  const job = listJobs()[0];
  assert.ok(job.progress.length > 0);
  // 只回最近 12 条
  assert.ok(job.progress.length <= 12, `进度最多回 12 条，实际 ${job.progress.length}`);
  const last = job.progress[job.progress.length - 1];
  assert.equal(last.message, '第 10 步');
});

test('currentReporter 能在任务内取到上报函数，任务外是空函数', async () => {
  resetJobs();
  let captured = null;
  await runJob({
    kind: 'export',
    title: 'x',
    task: () => {
      captured = currentReporter();
      captured('inside', 50);
      return { ok: true };
    },
  });
  assert.equal(typeof captured, 'function');
  // 任务外
  const outside = currentReporter();
  assert.equal(typeof outside, 'function');
  assert.doesNotThrow(() => outside('noop'));
});

test('clearFinished 只清已完成的，不动进行中的', async () => {
  resetJobs();
  await runJob({ kind: 'export', title: 'a', task: () => ({ ok: true }) });
  await runJob({ kind: 'import', title: 'b', task: () => ({ ok: true }) });
  assert.equal(listJobs().length, 2);

  const removed = clearFinished();
  assert.equal(removed, 2);
  assert.equal(listJobs().length, 0);
});

test('结果摘要不含巨大的 manifest', async () => {
  resetJobs();
  const bigManifest = { plugins: Array.from({ length: 100 }, (_, i) => ({ name: `p${i}` })) };
  const { job } = await runJob({
    kind: 'export',
    title: 'big',
    task: () => ({
      ok: true,
      file: 'D:/x.zip',
      bytes: 1,
      manifest: bigManifest,
      warnings: Array.from({ length: 50 }, (_, i) => `w${i}`),
    }),
  });

  // 摘要里不该带 manifest
  assert.equal('manifest' in job.result, false, '不该把 manifest 塞进任务记录');
  // warnings 截到 10 条
  assert.ok(job.result.warnings.length <= 10, `warnings 应截断，实际 ${job.result.warnings.length}`);

  // 序列化后体积要小
  const serialized = JSON.stringify(job.result);
  assert.ok(serialized.length < 3000, `摘要应很小，实际 ${serialized.length} 字符`);
});

test('超过上限时清理最老的已完成任务', async () => {
  resetJobs();
  for (let i = 0; i < 50; i += 1) {
    await runJob({ kind: 'export', title: `job-${i}`, task: () => ({ ok: true }) });
  }
  const jobs = listJobs({ limit: 100 });
  assert.ok(jobs.length <= 45, `应被裁剪到上限附近，实际 ${jobs.length}`);
  // 保留的应该是最新的
  assert.equal(jobs[0].title, 'job-49');
});
