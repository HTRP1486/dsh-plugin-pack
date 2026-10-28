/**
 * 体积上限的回归测试。
 *
 * 起因：用户全选插件（598.5 MiB 未压缩）时被默认 512 MiB 挡掉，
 * 报错只说"调大 maxBytes"，界面上根本找不到这个开关。
 *
 * 关键认知：上限按**未压缩**字节算，而压缩比约 1:3 ——
 * 实测 479 MiB 原始内容 → 166 MiB 的 zip。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { test } from 'node:test';

import { exportBundle } from '../lib/export.js';
import { DEFAULTS } from '../lib/index.js';

const OUT = path.join(os.tmpdir(), 'dsh-pp-limit-test');

test('默认上限已提高到 2 GiB（原 512 MiB 会挡掉正常全量备份）', async () => {
  assert.equal(DEFAULTS.maxBytes, 2 * 1024 * 1024 * 1024);
  assert.ok(DEFAULTS.maxBytes > 512 * 1024 * 1024, '必须大于旧的 512 MiB');
});

test('maxBytes: 0 表示不限制（不是退回默认值）', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const dry = await exportBundle({ include: ['dsh-plugin-pack'], dryRun: true, maxBytes: 0 });
  assert.ok(dry.bytes > 0);
  assert.equal(dry.dryRun, true);
});

test('上限 1 字节必然抛 TOO_LARGE，且提示可操作', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  // exportBundle 现在是异步的，必须用 rejects 而不是 try/catch
  let caught = null;
  try {
    await exportBundle({ include: ['dsh-plugin-pack'], out: `${OUT}\\`, maxBytes: 1 });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, '应抛错');
  assert.equal(caught.code, 'TOO_LARGE');
  assert.ok(/体积上限/.test(caught.message));
  // 文案要告诉用户去哪儿改
  assert.ok(/导出页|体积上限|不限制/.test(caught.message), `文案应可操作，实际: ${caught.message}`);
});

test('界面上限换算正确：MiB → 字节，0 → 不限制', async () => {
  // 复刻界面里的换算：maxMb > 0 ? maxMb*1024*1024 : 0
  const toBytes = (maxMb) => (maxMb > 0 ? Math.round(Number(maxMb) * 1024 * 1024) : 0);
  assert.equal(toBytes(0), 0);
  assert.equal(toBytes(600), 629145600);
  assert.equal(toBytes(2048), 2147483648);

  // 0 传下去要被当作 Infinity
  const dry = await exportBundle({ include: ['dsh-plugin-pack'], dryRun: true, maxBytes: toBytes(0) });
  assert.equal(dry.ok, true, '0 = 不限制，不应被挡');
});

test('「按当前选择自动调大」的算法留了 15% 余量', async () => {
  const chosenBytes = 598.5 * 1024 * 1024;
  const suggested = Math.ceil((chosenBytes * 1.15) / 1048576);
  assert.ok(suggested > 598.5, '必须大于实际体积');
  assert.ok(suggested < 800, '也不能离谱地大');
  assert.equal(suggested, 689);

  // 用它真能通过
  const dry = await exportBundle({ include: ['dsh-plugin-pack'], dryRun: true, maxBytes: suggested * 1024 * 1024 });
  assert.equal(dry.ok, true);
});

test('压缩后再看体积：上限按未压缩算，成品要小得多', async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  const result = await exportBundle({ include: ['dsh-plugin-pack', 'dsh-one-click-polish'], out: `${OUT}\\`, maxBytes: 0 });
  assert.ok(result.rawBytes > 0);
  assert.ok(result.bytes > 0);
  assert.ok(fs.existsSync(result.file));
  // 文档里声称压缩比约 1:3，至少要真的变小
  assert.ok(result.bytes <= result.rawBytes, '成品不应大于原始');
  fs.rmSync(OUT, { recursive: true, force: true });
});
