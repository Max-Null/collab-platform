import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEVER_HIT_THRESHOLD, judgeHealth } from '../src/policy/health.js';

/**
 * 这一组测的是**三种「看起来一样」的情况能不能被分开**：
 * 根本没开 / 没什么可拦 / 拦不住 —— 它们的现象都是「没有命中记录」。
 */

test('停用：即使跑过、也命中过，仍然报 off —— 停用压过一切', () => {
  const h = judgeHealth({ enabled: false, total: 100, hit: 30 });
  assert.equal(h.health, 'off');
  assert.ok(h.note.includes('看起来和「没什么可拦」一样'), '要说清它为什么会骗人');
});

test('跑得还少：不让人拿噪声当证据', () => {
  const h = judgeHealth({ enabled: true, total: 3, hit: 0 });
  assert.equal(h.health, 'tooFewRuns');
  assert.ok(h.note.includes('看不出它拦不拦得住'));
});

test('零命中：跑够了却一次没命中，要问的是两个不同的问题', () => {
  const h = judgeHealth({ enabled: true, total: NEVER_HIT_THRESHOLD, hit: 0 });
  assert.equal(h.health, 'neverHit');
  assert.ok(
    h.note.includes('判据太窄') && h.note.includes('根本不存在'),
    '「太窄」和「不存在」是两种完全不同的原因，提示要把两个都问出来',
  );
});

test('正常：命中过就不报', () => {
  assert.equal(judgeHealth({ enabled: true, total: 50, hit: 1 }).health, 'ok');
  // 边界：跑够次数且有命中
  assert.equal(judgeHealth({ enabled: true, total: NEVER_HIT_THRESHOLD, hit: 1 }).health, 'ok');
  // 边界：差一次到阈值，仍算「跑得还少」
  assert.equal(
    judgeHealth({ enabled: true, total: NEVER_HIT_THRESHOLD - 1, hit: 0 }).health,
    'tooFewRuns',
  );
});
