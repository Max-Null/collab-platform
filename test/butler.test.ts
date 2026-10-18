import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordStore } from '../src/record/store.js';
import { inferWindow } from '../src/butler/ask.js';
import { ask } from '../src/butler/ask.js';
import { buildFacts, renderFacts } from '../src/butler/facts.js';
import { tour } from '../src/butler/tour.js';
import type { LlmClient } from '../src/llm/client.js';
import type { JudgmentRecord } from '../src/types.js';

/**
 * 管家那一层。
 *
 * 它比判据那边更容易悄悄坏，因为它的产物是**一段读起来通顺的话** ——
 * 编错了也不报错，而一段说得挺好的错误比一个空白危险得多。
 * 所以这里测的不是「话说得漂不漂亮」，是**它有没有说它不该说的话**。
 */

function rec(over: Partial<JudgmentRecord>): JudgmentRecord {
  return {
    eventId: 'e',
    policyId: 'p',
    policyVersion: 'v1',
    outcome: 'miss',
    evidenceJson: '[]',
    origin: 'effective',
    createdAt: '2026-10-18T01:00:00.000Z',
    ...over,
  };
}

/** 一个只会原样吐回预先给的那段文本的模型 */
function fakeLlm(text: string, shouldThrow = false): LlmClient {
  return {
    name: 'fake',
    model: 'fake',
    complete: async () => {
      if (shouldThrow) throw new Error('模型不通');
      return { text, model: 'fake' };
    },
  };
}

/* ── 日期词 → 窗口 ────────────────────────────────────────── */

test('日期词映射：昨天是 24 小时，上周是 168 小时', () => {
  assert.equal(inferWindow('昨天有什么动静').hours, 24);
  assert.equal(inferWindow('昨晚那次改动奇怪吗').hours, 24);
  assert.equal(inferWindow('上周谁改得最多').hours, 168);
  assert.equal(inferWindow('上周谁改得最多').label, '上周');
});

test('问句里没有时间线索时用默认值，并如实标出它的说法', () => {
  const w = inferWindow('AuthConfig 那个改动是怎么判的');
  assert.equal(w.hours, 24);
  assert.equal(w.label, '最近 24 小时');
});

/* ── 事实包：窗口与切片 ───────────────────────────────────── */

test('noWindow：界面上摆着哪一批，导览就看哪一批 —— 不许按时间另切一刀', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(
      rec({ eventId: 'old', outcome: 'error', createdAt: new Date(Date.now() - 3 * 86400_000).toISOString() }),
    );
    store.save(rec({ eventId: 'new', outcome: 'hit', createdAt: new Date().toISOString() }));

    // 按时间切：三天前那次落在 24 小时窗口外
    const windowed = buildFacts(store, { hours: 24 });
    assert.equal(windowed.changes.length, 1);
    assert.equal(windowed.changes[0]?.eventId, 'new');

    // 不按时间切：两次都在。这就是导览该拿到的材料 ——
    // 否则会出现「下面明明有一件这次没看成，导览却说没有」。
    const all = buildFacts(store, { hours: 24, noWindow: true });
    assert.deepEqual(all.changes.map((c) => c.eventId).sort(), ['new', 'old']);
  } finally {
    store.close();
  }
});

test('每条判定的表态状态都写死 —— 空字段不是「没有」，是两可', () => {
  const store = new RecordStore(':memory:');
  try {
    const id = store.save(rec({ eventId: 'e1', outcome: 'hit', title: 't' }));
    const facts = buildFacts(store, { noWindow: true });
    const text = renderFacts(facts);

    assert.match(text, /人的表态：还没有任何人表态/, '没人表态要明写，否则模型会自己补一句「已确认过」');

    store.setReaction(id, 'adopted', new Date().toISOString(), '确实漏写');
    const after = renderFacts(buildFacts(store, { noWindow: true }));
    assert.match(after, /人的表态：adopted（确实漏写）/);
  } finally {
    store.close();
  }
});

test('窗口里没有变更时，说明里要写清「可能没在看着」——不能只说「没有变更」', () => {
  const store = new RecordStore(':memory:');
  try {
    const facts = buildFacts(store, { hours: 24 });
    assert.equal(facts.changes.length, 0);
    const text = renderFacts(facts);
    assert.match(text, /平台没在看着/, '「没有变更」与「没在看着」从库里分不出来，必须说出来');
  } finally {
    store.close();
  }
});

/* ── 问答 ─────────────────────────────────────────────────── */

test('没配模型时不返回任何回答 —— 不给半句编的话', async () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', outcome: 'hit', title: 't' }));
    const res = await ask('昨天有什么', {
      store,
      llm: fakeLlm('假装我说了什么'),
      llmConfigured: false,
    });

    assert.equal(res.ok, false);
    assert.equal(res.answer, undefined, '没模型却给回答，等于把「没看」说成「看过」');
    assert.match(res.error ?? '', /没有配置模型/);
    // 材料照给：说她答不上来，不等于把人晾在那儿
    assert.equal(res.facts.changes.length, 1);
  } finally {
    store.close();
  }
});

test('模型返回空内容算失败，不算「没什么可说的」', async () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', outcome: 'hit', title: 't' }));
    const res = await ask('昨天有什么', {
      store,
      llm: fakeLlm('   '),
      llmConfigured: true,
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /空内容/);
    assert.match(res.error ?? '', /不等于「没什么可说的」/);
  } finally {
    store.close();
  }
});

test('模型调不通时说调不通，不编一个「没问题」出来', async () => {
  const store = new RecordStore(':memory:');
  try {
    const res = await ask('昨天有什么', {
      store,
      llm: fakeLlm('', true),
      llmConfigured: true,
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /没调通/);
  } finally {
    store.close();
  }
});

/* ── 导览 ─────────────────────────────────────────────────── */

test('导览：挂不到任何变更上的解说要丢弃并计数，不许张冠李戴', async () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'real-1', outcome: 'hit', title: '配置管理', project: 'g/app' }));

    const modelSays = JSON.stringify({
      intro: '有一件要说。',
      stops: [
        { eventId: 'real-1', why: '它在等你表态', say: '这条真的存在。' },
        { eventId: 'made-up-9', why: '这件不存在', say: '模型编的展品编号。' },
      ],
      closing: '就这些。',
    });

    const res = await tour({ store, llm: fakeLlm(modelSays), llmConfigured: true });

    assert.equal(res.ok, true);
    assert.equal(res.tour?.stops.length, 1, '挂不上的那条必须丢掉');
    assert.equal(res.droppedStops, 1, '丢了几条要报出来 —— 否则「讲了 2 件」与「讲了 1 件、1 件扔了」一样');
    assert.equal(res.tour?.stops[0]?.order, 1);
  } finally {
    store.close();
  }
});

test('导览：返回的不是约定 JSON 时不产出导览', async () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', outcome: 'hit', title: 't' }));
    const res = await tour({ store, llm: fakeLlm('好的，我看了一下，有两条命中。'), llmConfigured: true });

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /不是约定的 JSON/);
  } finally {
    store.close();
  }
});

test('导览：没配模型时不给导览 —— 模板拼出来的「导览」会看起来像她想过了', async () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', outcome: 'hit', title: 't' }));
    const res = await tour({ store, llm: fakeLlm('{}'), llmConfigured: false });

    assert.equal(res.ok, false);
    assert.equal(res.tour, undefined);
    assert.match(res.error ?? '', /没法替你先看一遍/);
  } finally {
    store.close();
  }
});

test('导览：一件变更都没有时不调模型，也不能说「今天没问题」', async () => {
  const store = new RecordStore(':memory:');
  try {
    const res = await tour({ store, llm: fakeLlm('不该被调到'), llmConfigured: true });

    assert.equal(res.ok, true);
    assert.equal(res.tour?.stops.length, 0);
    // 「没有变更」与「没在看着」长得一样，这句话必须出现在开场里
    assert.match(res.tour?.intro ?? '', /没在看着/);
  } finally {
    store.close();
  }
});
