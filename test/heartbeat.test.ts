import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanDuration, judgeDaemon, toBeatSlots } from '../src/heartbeat.js';
import { RecordStore } from '../src/record/store.js';
import type { Heartbeat } from '../src/types.js';

/**
 * 这一组测的是**「它还在不在」能不能被分开**：
 * 从没跑过 / 在跑 / 迟了 / 已经停了。
 *
 * 四种状态在判断记录上长得一模一样 —— 都没有新记录。而处置完全不同：
 * 一种是「等着就行」，一种是「去把进程拉起来」。
 * 起因很具体：一个控制台挂着 21 小时前的数据、界面齐全，
 * 却没有任何地方说得出「它已经很久没动了」。
 */

const INTERVAL = 300_000; // 5 分钟

function beat(at: string, over: Partial<Heartbeat> = {}): Heartbeat {
  return {
    at,
    ok: true,
    intervalMs: INTERVAL,
    events: 2,
    judged: 2,
    skipped: 0,
    durationMs: 1200,
    ...over,
  };
}

/** 以 now 为基准往前推 ms 毫秒的一个时刻 */
function ago(now: Date, ms: number): string {
  return new Date(now.getTime() - ms).toISOString();
}

const NOW = new Date('2026-10-15T06:00:00Z');

test('从没跑过：不能报成「停了」—— 还没部署与挂了是两件事', () => {
  const d = judgeDaemon({ now: NOW });
  assert.equal(d.status, 'never');
  assert.ok(
    d.note.includes('没有任何心跳记录'),
    '要说清这意味着下面那些数字来自别处，否则人会以为平台在跑',
  );
  assert.ok(
    !d.note.includes('从来没跑过'),
    '言之凿凿说「从来没跑过」是错的：心跳是后加的层，在那之前跑过的库记录在、心跳不在',
  );
});

test('在跑：刚跑完一轮就报 alive，并把这一轮的成绩一起说出来', () => {
  const d = judgeDaemon({ last: beat(ago(NOW, 30_000)), now: NOW });
  assert.equal(d.status, 'alive');
  assert.ok(d.note.includes('拉到 2 个事件') && d.note.includes('新判 2 条'));
});

test('宽限：一轮跑得比预期久不算停摆 —— 误报多了，真停摆也没人信', () => {
  // 2 倍以内：活着
  assert.equal(judgeDaemon({ last: beat(ago(NOW, INTERVAL * 2)), now: NOW }).status, 'alive');
  // 刚过 2.5 倍：迟了
  assert.equal(
    judgeDaemon({ last: beat(ago(NOW, INTERVAL * 2.5 + 1000)), now: NOW }).status,
    'late',
  );
});

test('迟了：超过宽限、但还没到「没了」的程度 —— 说法要能指导动作', () => {
  const d = judgeDaemon({ last: beat(ago(NOW, INTERVAL * 5)), now: NOW });
  assert.equal(d.status, 'late');
  assert.ok(d.note.includes('迟了'), '说成「停摆」会让人去重启一个其实还活着的进程');
});

test('停了：超过预期间隔 10 倍 —— 这一步就不是「慢」，是没了', () => {
  const d = judgeDaemon({ last: beat(ago(NOW, INTERVAL * 21)), now: NOW });
  assert.equal(d.status, 'stopped');
  assert.ok(d.note.includes('它已经不在了'));
});

test('阈值跟着预期间隔走：每小时一轮的进程不该被 5 分钟一轮的尺度判死', () => {
  const hourly = beat(ago(NOW, 50 * 60_000), { intervalMs: 3_600_000 });
  assert.equal(judgeDaemon({ last: hourly, now: NOW }).status, 'alive');

  // 同一个「50 分钟前」，对 5 分钟一轮的进程就已经过了 10 倍
  assert.equal(judgeDaemon({ last: beat(ago(NOW, 55 * 60_000)), now: NOW }).status, 'stopped');
});

test('上一轮失败：仍在跑，但要把失败原因带出来 —— 失败不写就只剩「安静」', () => {
  const d = judgeDaemon({ last: beat(ago(NOW, 20_000), { ok: false, error: 'GitLab 502' }), now: NOW });
  assert.equal(d.status, 'alive');
  assert.ok(d.note.includes('上一轮失败') && d.note.includes('GitLab 502'));
});

test('最后一条判断记录：与心跳成对才有意义 —— 单看任何一个都答不出该做什么', () => {
  const quiet = judgeDaemon({
    last: beat(ago(NOW, 20_000)),
    lastJudgmentAt: ago(NOW, 21 * 3_600_000),
    now: NOW,
  });
  assert.equal(quiet.status, 'alive');
  assert.ok(quiet.lastJudgmentNote.includes('21 小时'), '「在跑但很久没新记录」要看得见');

  // 一条记录都没有，与「有记录但很久」是两种不同的说法
  assert.ok(
    judgeDaemon({ last: beat(ago(NOW, 20_000)), now: NOW }).lastJudgmentNote.includes(
      '一条判断记录都没有',
    ),
  );

  // 坏数据不该被念成一个具体的时间
  const broken = judgeDaemon({ last: beat(ago(NOW, 20_000)), lastJudgmentAt: '不是时间', now: NOW });
  assert.ok(broken.lastJudgmentNote.includes('一条判断记录都没有'));
});

test('时间的念法：刻意粗 —— 这一层要的是「大概多久」，精确到秒是一种假的可信', () => {
  assert.equal(humanDuration(30_000), '30 秒');
  assert.equal(humanDuration(5 * 60_000), '5 分钟');
  assert.equal(humanDuration(3 * 3_600_000), '3 小时');
  assert.equal(humanDuration(50 * 3_600_000), '2 天');
});

test('心跳的读写往返：没有过心跳时是 undefined，不是「一条空记录」', () => {
  const store = new RecordStore(':memory:');
  try {
    assert.equal(store.lastHeartbeat(), undefined);

    store.saveHeartbeat(beat('2026-10-15T06:00:00.000Z'));
    assert.equal(store.lastHeartbeat()?.at, '2026-10-15T06:00:00.000Z');
    assert.equal(store.lastHeartbeat()?.ok, true);
    assert.equal(store.lastHeartbeat()?.intervalMs, INTERVAL);

    // 失败的那一轮也要存得下、读得回 —— 否则它就成了「没跑过」
    store.saveHeartbeat(beat('2026-10-15T06:05:00.000Z', { ok: false, error: 'GitLab 502' }));
    assert.equal(store.lastHeartbeat()?.ok, false);
    assert.equal(store.lastHeartbeat()?.error, 'GitLab 502');
  } finally {
    store.close();
  }
});

test('心跳不进观察期的任何分母 —— 它不是一次判断', () => {
  const store = new RecordStore(':memory:');
  try {
    for (let i = 0; i < 3; i += 1) {
      store.saveHeartbeat(beat(`2026-10-15T06:0${i}:00.000Z`));
    }

    assert.equal(store.statsByPolicyVersion().length, 0, '心跳不该凭空造出一条策略的统计');
    assert.equal(store.flow().judgments, 0, '运行图上的判定数更不该被心跳顶上');
    assert.equal(store.listPendingReactions().length, 0, '心跳不是待办');
  } finally {
    store.close();
  }
});

/* ── 格带 ─────────────────────────────────────────────────────────────
   格带回答的是「最近稳不稳」—— 一个圆点回答不了这个。
   它的关键不在于好不好看，而在于**不得画错**。 */

test('格带按时间片铺：中间的空白必须留成空隙，不能画成连续的轮次', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const beats = [
    beat(new Date(now.getTime() - 4 * 3_600_000).toISOString()),
    beat(new Date(now.getTime() - 3_600_000).toISOString()),
  ];

  const slots = toBeatSlots(beats, { now, slots: 12 });

  assert.equal(slots.length, 12);
  assert.equal(slots.filter((s) => s.present).length, 2, '只有那两片里有心跳');
  assert.ok(
    slots.some((s) => !s.present),
    '两次心跳之间那三个小时必须画成空隙 —— 画成连续的两格，等于把一次 3 小时的停摆说成「一切正常」',
  );
});

test('片宽随跨度伸缩，而且它必须被带出来', () => {
  const now = new Date('2026-10-15T10:00:00Z');

  const close = toBeatSlots([beat(new Date(now.getTime() - 60_000).toISOString())], { now, slots: 12 });
  const far = toBeatSlots(
    [
      beat(new Date(now.getTime() - 21 * 3_600_000).toISOString()),
      beat(new Date(now.getTime() - 21 * 3_600_000 + 60_000).toISOString()),
    ],
    { now, slots: 12 },
  );

  const a = close[0];
  const b = far[0];
  assert.ok(a && b);
  assert.ok(a.spanMs > 0, '片宽要带出来：读者若默认一格固定是多久，看到的历史长短就全错了');
  assert.ok(b.spanMs > a.spanMs, '跨度被拉长时片宽要跟着变大');
});

test('一片里有失败就算没成 —— 失败不该被同一片里的成功盖掉', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const t = now.getTime() - 60_000;

  const slots = toBeatSlots(
    [
      beat(new Date(t).toISOString()),
      beat(new Date(t + 1000).toISOString(), { ok: false, error: 'GitLab 502' }),
    ],
    { now, slots: 12 },
  );

  const last = slots[slots.length - 1];
  assert.ok(last);
  assert.equal(last.present, true);
  assert.equal(last.ok, false, '同一片里有一轮挂了，这一片就不能显示成「都成了」');
  assert.ok(String(last.note).includes('GitLab 502'), '悬停时要能看见是为什么挂的');
});

test('从没跑过时格带是空的 —— 整条空与「跑过但停了」不是一回事', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const slots = toBeatSlots([], { now, slots: 12 });
  assert.equal(slots.length, 12);
  assert.equal(slots.filter((s) => s.present).length, 0, '一格都不该有：那是「从没跑过」的样子');
});

test('模型信息跟着心跳走：「不知道模型」与「模型没配上」是两件事', () => {
  const store = new RecordStore(':memory:');
  try {
    // 老心跳里根本没有模型信息 —— 那是不知情，不是「没配上」
    store.saveHeartbeat(beat('2026-10-15T06:00:00.000Z'));
    assert.equal(
      store.lastHeartbeat()?.modelConfigured,
      undefined,
      '不知道就该是「不知道」。补一个 false 会让人去查一个可能好好的配置',
    );

    // 知情、而且确实没配上
    store.saveHeartbeat(beat('2026-10-15T06:05:00.000Z', { model: 'stub', modelConfigured: false }));
    assert.equal(store.lastHeartbeat()?.modelConfigured, false);
    assert.equal(store.lastHeartbeat()?.model, 'stub');

    // 配上了就报出是哪个模型 —— 界面要显示的是「跑判断的那个进程」用的东西
    store.saveHeartbeat(
      beat('2026-10-15T06:10:00.000Z', { model: 'qwen3.6-plus', modelConfigured: true }),
    );
    assert.equal(store.lastHeartbeat()?.model, 'qwen3.6-plus');
    assert.equal(store.lastHeartbeat()?.modelConfigured, true);
  } finally {
    store.close();
  }
});
