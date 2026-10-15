import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordStore } from '../src/record/store.js';
import type { JudgmentRecord } from '../src/types.js';

/**
 * 观察表那两件东西的数据通路。
 *
 * 一条是**点图**：样本不足时画点、不画比例。点图要的是逐条结局，
 * 而「逐条」这件事不能被聚合数字代替 —— 从 `hit=4 / miss=6` 反推出来的
 * 顺序是编的，而点图恰好把顺序画在读者眼前。
 */

function rec(over: Partial<JudgmentRecord>): JudgmentRecord {
  return {
    eventId: 'e',
    policyId: 'p',
    policyVersion: 'v1',
    outcome: 'miss',
    evidenceJson: '[]',
    origin: 'effective',
    createdAt: '2026-10-15T01:00:00.000Z',
    ...over,
  };
}

test('点图的数据是逐条记录，不是从聚合数字反推的', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', createdAt: '2026-10-15T01:00:00.000Z' }));
    store.save(rec({ eventId: 'e2', outcome: 'hit', createdAt: '2026-10-15T02:00:00.000Z' }));
    store.save(rec({ eventId: 'e3', outcome: 'error', createdAt: '2026-10-15T03:00:00.000Z' }));

    const st = store.statsByPolicyVersion()[0];
    assert.ok(st);
    assert.equal(st.total, 3);
    assert.deepEqual(
      st.sequence?.map((x) => x.outcome),
      ['miss', 'hit', 'error'],
      '必须按时间正序逐条给 —— 聚合数字里没有顺序，而点图把顺序画在读者眼前',
    );
  } finally {
    store.close();
  }
});

test('已被人表过态的那几条要被标出来 —— 点图用描边表达「这个有人看过」', () => {
  const store = new RecordStore(':memory:');
  try {
    const a = store.save(rec({ eventId: 'e1' }));
    store.save(rec({ eventId: 'e2', outcome: 'hit', createdAt: '2026-10-15T02:00:00.000Z' }));

    assert.equal(store.statsByPolicyVersion()[0]?.sequence?.[0]?.reviewed, false, '都还没人看过');

    store.setReaction(a, 'adopted', '2026-10-15T04:00:00.000Z');

    const st = store.statsByPolicyVersion()[0];
    assert.equal(st?.sequence?.[0]?.reviewed, true, '回过写的那条要能分辨');
    assert.equal(st?.sequence?.[1]?.reviewed, false, '没回过写的不要被带上');
    // 「评估」与「看过」是两个分母，别混 —— 升级判据只认后者
    assert.equal(st?.total, 2);
    assert.equal(st?.reviewed, 1);
  } finally {
    store.close();
  }
});

test('影子判定不进序列 —— 它没进过人的视野', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1' }));
    store.save(rec({ eventId: 'e2', outcome: 'hit', origin: 'shadow' }));

    const st = store.statsByPolicyVersion()[0];
    assert.equal(st?.total, 1);
    assert.equal(st?.sequence?.length, 1, '影子判定不该出现在点图里：没人看见过它');
  } finally {
    store.close();
  }
});
