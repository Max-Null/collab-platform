import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLD_AT, renderBriefing } from '../src/briefing.js';
import type { Heartbeat, JudgmentRecord } from '../src/types.js';

/**
 * 这一组测的是**简报的纪律**，不是它的排版。
 *
 * 那纪律只有一条核心：**没内容就不发**。因为它是这个平台里唯一主动占用
 * 人注意力的东西 —— 一旦它每天都响，它响的时候也没人会看了，
 * 而那时它已经失去全部价值，只是没人会注意到这件事。
 */

const NOW = new Date('2026-10-15T10:00:00Z');
const INTERVAL = 300_000;

function beat(at: string): Heartbeat {
  return { at, ok: true, intervalMs: INTERVAL, events: 3, judged: 3, skipped: 0, durationMs: 900 };
}

function row(id: number, over: Partial<JudgmentRecord> = {}): JudgmentRecord {
  return {
    id,
    eventId: `e-${id}`,
    policyId: 'review-claim-mismatch',
    policyVersion: '0.1.0',
    outcome: 'hit',
    reason: `第 ${id} 条的理由`,
    evidenceJson: '[]',
    origin: 'effective',
    createdAt: '2026-10-15T09:00:00.000Z',
    ...over,
  };
}

const base = {
  now: NOW,
  lastBeat: beat(new Date(NOW.getTime() - 60_000).toISOString()),
  lastJudgmentAt: '2026-10-15T09:30:00.000Z',
  stats: [],
  last24h: 3,
};

test('没内容就不发：没有待办、平台也在跑时返回 undefined', () => {
  assert.equal(
    renderBriefing({ ...base, pending: [], errors: [] }),
    undefined,
    '一个每天都说「今天没什么事」的播报，会让人连打开的欲望都没有 —— 它响了就一定要有内容',
  );
});

test('判断没做成排在等表态前面 —— 它不是「有问题」，是「这次没看」', () => {
  const text = renderBriefing({
    ...base,
    pending: [row(1)],
    errors: [row(2, { outcome: 'error', reason: '模型返回的不是约定的 JSON' })],
  });
  assert.ok(text);
  const iError = text.indexOf('判断没做成');
  const iPending = text.indexOf('等你表态');
  assert.ok(iError >= 0 && iPending >= 0, '两节都该在');
  assert.ok(iError < iPending, '没做成的那一节要在前面：它更不容易被注意到，因为它不留痕迹');
});

test('平台停了就发 —— 哪怕一条待办都没有', () => {
  const stopped = beat(new Date(NOW.getTime() - 21 * 3_600_000).toISOString());
  const text = renderBriefing({ ...base, lastBeat: stopped, pending: [], errors: [] });
  assert.ok(text, '常驻停了本身就是一件要人决定的事');
  assert.ok(
    text.includes('已经不在了') || text.includes('常驻已经停了'),
    `要说清它停了，实际：${text.slice(0, 160)}`,
  );
});

test('从没跑过也发，而且说法与「停了」不同', () => {
  const text = renderBriefing({ ...base, lastBeat: undefined, pending: [], errors: [] });
  assert.ok(text);
  assert.ok(text.includes('没有任何心跳记录'), '「从没跑过」与「跑过但停了」要分开说');
  assert.ok(!text.includes('已经不在了'), '两边混用会让人不知道该去做什么');
});

test('超过 FOLD_AT 条就折叠 —— 列全等于没列', () => {
  const many = Array.from({ length: FOLD_AT + 7 }, (_, i) => row(i + 1));
  const text = renderBriefing({ ...base, pending: many, errors: [] });
  assert.ok(text);
  assert.ok(text.includes('还有 7 条'), '要说出一共还剩几条没列出来');
  assert.ok(text.includes('控制台的代办页'), '还要说清去哪儿看全 —— 折叠不是让人看不到');
});

test('平台状态排在待办之前 —— 它没在跑时，下面所有数字都失效', () => {
  const text = renderBriefing({ ...base, pending: [row(1)], errors: [] });
  assert.ok(text);
  assert.ok(text.indexOf('**平台**') < text.indexOf('等你表态'));
});

test('观察期只报数、不给建议', () => {
  const text = renderBriefing({
    ...base,
    pending: [row(1)],
    errors: [],
    stats: [
      {
        policyId: 'p',
        policyVersion: 'v1',
        total: 10,
        reviewed: 2,
        hit: 3,
        miss: 6,
        error: 1,
        adopted: 1,
        rejected: 1,
        ignored: 0,
      },
    ],
  });
  assert.ok(text);
  assert.ok(text.includes('| 10 |'), '数字要在表里');
  // 「GM 报数据，不要权限」—— 一句评价都不该出现
  for (const banned of ['建议升级', '应该升级', '表现良好', '命中率偏低', '需要关注']) {
    assert.ok(!text.includes(banned), `不该出现评价性措辞：${banned}`);
  }
});

const dead = (at: string): Heartbeat => ({ ...beat(at), ok: false, error: 'fetch failed' });

test('探针不通要说 —— 那是图唯一说不了的一件事', () => {
  const text = renderBriefing({
    ...base,
    pending: [],
    errors: [],
    probe: { url: 'http://127.0.0.1:8793/', ok: false, error: 'fetch failed' },
  });
  assert.ok(text, '控制台打不开，而简报是少数还能开口的出口之一');
  assert.match(text, /打不开/);
  assert.match(text, /fetch failed/, '原因照原文给');
});

test('探得通就不占版面 —— 没事别说话', () => {
  const text = renderBriefing({
    ...base,
    pending: [],
    errors: [],
    probe: { url: 'http://127.0.0.1:8793/', ok: true, ms: 12 },
  });
  assert.equal(text, undefined, '探通是常态，不是新闻');
});

test('孤立的一轮失败不占版面 —— 变了味的告警等于没有告警', () => {
  const text = renderBriefing({
    ...base,
    pending: [],
    errors: [],
    recentBeats: [beat('2026-10-15T09:00:00Z'), dead('2026-10-15T09:05:00Z'), beat('2026-10-15T09:10:00Z')],
  });
  assert.equal(text, undefined, '一轮失败多半是抖动，它自己会好');
});

test('连着两轮失败就要说话 —— 这些事发生时没人被告知过', () => {
  const text = renderBriefing({
    ...base,
    pending: [],
    errors: [],
    recentBeats: [
      beat('2026-10-15T09:00:00Z'),
      dead('2026-10-15T09:05:00Z'),
      dead('2026-10-15T09:10:00Z'),
    ],
  });
  assert.ok(text, '连续两轮已经跨过一个完整的轮询间隔，那不是抖动');
  assert.match(text, /最近出过事/);
  assert.match(text, /连续 \*\*2 轮\*\*/);
  assert.match(text, /fetch failed/, '原因照原文给');
  assert.match(text, /不会因此漏判/, '要说清它不会造成漏判，否则读的人第一反应是「那漏了什么」');
  assert.ok(
    !text.includes('2026-10-15T09:05'),
    '时刻要按本地时间写成人能读的样子，不要把 ISO 的 UTC 原样摆出来',
  );
});
