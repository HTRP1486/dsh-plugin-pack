/**
 * 导入冲突的「待决策」机制。
 *
 * 要解决的问题：用户在冲突弹窗里没做选择就切走画面 ——
 * 组件卸载、前端 state 丢失，那次导入悬在半空（文件传上去了但没人处理）。
 *
 * 现在：冲突登记成服务端的 waiting 任务，切回来能捡回弹窗；
 * 一直不决策就走 cancel，视为放弃。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  openWaiting,
  getWaiting,
  listWaiting,
  cancelWaiting,
  resumeWaiting,
  runJob,
  getJob,
  resetJobs,
  runningJobs,
} from '../lib/jobs.js';

test('登记待决策任务：状态 waiting，带上冲突列表', () => {
  resetJobs();
  const id = openWaiting({
    kind: 'import',
    title: '导入整合包（2 个重名待决定）',
    meta: { file: 'D:/a.zip' },
    payload: {
      file: 'D:/a.zip',
      conflicts: [
        { name: 'dsh-pet', version: '0.3.8', installedVersion: '0.3.7' },
        { name: 'dsh-ops', version: '0.4.1', installedVersion: '0.4.1', sameVersion: true },
      ],
    },
  });

  assert.ok(id);
  const waiting = getWaiting(id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.payload.conflicts.length, 2);
  assert.equal(waiting.payload.file, 'D:/a.zip');
  assert.equal(waiting.payload.conflicts[0].name, 'dsh-pet');
});

test('listWaiting 只列待决策的，不列已跑完的', () => {
  resetJobs();
  const id1 = openWaiting({ kind: 'import', title: 'A', payload: { conflicts: [{ name: 'a' }] } });
  const id2 = openWaiting({ kind: 'import', title: 'B', payload: { conflicts: [{ name: 'b' }] } });

  let list = listWaiting();
  assert.equal(list.length, 2);

  cancelWaiting(id1, '用户取消');
  list = listWaiting();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id2);
});

test('取消待决策：状态变 cancelled，payload 清空', () => {
  resetJobs();
  const id = openWaiting({ kind: 'import', title: 'x', payload: { conflicts: [{ name: 'a' }] } });

  assert.equal(cancelWaiting(id, '用户切走了画面'), true);
  const job = getJob(id);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.error, '用户切走了画面');
  // 取消后不该再能从 waiting 接口捞出来
  assert.equal(getWaiting(id), null);
});

test('重复取消返回 false（幂等）', () => {
  resetJobs();
  const id = openWaiting({ kind: 'import', title: 'x', payload: {} });
  assert.equal(cancelWaiting(id), true);
  assert.equal(cancelWaiting(id), false, '第二次取消应返回 false');
});

test('取消不存在的任务返回 false', () => {
  resetJobs();
  assert.equal(cancelWaiting('nope'), false);
});

test('决策后复用同一个 jobId：同一条记录从 waiting 变 running', async () => {
  resetJobs();
  const id = openWaiting({ kind: 'import', title: '导入整合包', payload: { conflicts: [{ name: 'a' }] } });

  // 用户做了决策，带同一个 jobId 真跑
  const { id: returned, job } = await runJob({
    kind: 'import',
    title: '导入整合包',
    jobId: id,
    task: () => ({ ok: true, plugins: [{ name: 'a', action: 'overwrite' }] }),
  });

  assert.equal(returned, id, '应复用同一个任务 id');
  assert.equal(job.status, 'done');
  assert.equal(job.payload, null, '决策后 payload 应清空');

  // 不该再出现在 waiting 列表里
  assert.equal(listWaiting().length, 0);
});

test('resumeWaiting 把 waiting 转成 running', () => {
  resetJobs();
  const id = openWaiting({ kind: 'import', title: 'x', payload: { conflicts: [] } });
  assert.equal(resumeWaiting(id), true);
  const job = getJob(id);
  assert.equal(job.status, 'running');
});

test('resumeWaiting 对已取消的任务返回 false', () => {
  resetJobs();
  const id = openWaiting({ kind: 'import', title: 'x', payload: {} });
  cancelWaiting(id);
  assert.equal(resumeWaiting(id), false);
});

test('待决策任务不会被当成"进行中"（不影响 tasks 轮询）', () => {
  resetJobs();
  openWaiting({ kind: 'import', title: 'x', payload: {} });
  // waiting 不是 running，界面不该为它每 1.5 秒空转轮询
  assert.equal(runningJobs().length, 0);
});

test('界面源码：切走画面时用 keepalive 通知取消', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const src = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  assert.ok(src.includes('keepalive: true'), '卸载时应尽量送达取消请求');
  assert.ok(src.includes('/plugin-pack/waiting/cancel'), '调用取消接口');
  assert.ok(src.includes('const cancelImport = async'), '应有取消函数');
  assert.ok(src.includes('getWaiting()'), '挂载时应拉取待决策任务');
  assert.ok(src.includes('resumed: true'), '恢复的弹窗应带 resumed 标记');
});
