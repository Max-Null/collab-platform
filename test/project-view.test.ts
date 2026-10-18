import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordStore } from '../src/record/store.js';
import type { JudgmentRecord } from '../src/types.js';

/**
 * 项目视图的数据通路。
 *
 * 这一层要回答的问题与「判断记录」不同：判断记录按**策略**组织（哪条策略判了多少次），
 * 项目视图按**变更**组织（我的仓库里有几件事、哪件要我管）。
 * 后者是管理员脑子里的事，而它必须由这一层聚出来 —— 界面变不出一份不存在的数据。
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

test('事件快照要落库并读得回来 —— 否则「判的是谁的哪次变更」永远没有答案', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(
      rec({
        eventId: 'e1',
        project: 'g/app',
        author: '张三',
        title: 'feat: 配置管理',
        eventKind: 'mr',
        changedFiles: ['a.yml', 'b.java'],
        sha: 'abc123',
        mrIid: 7,
        outcome: 'hit',
      }),
    );

    const g = store.listChanges()[0];
    assert.ok(g);
    assert.equal(g.project, 'g/app');
    assert.equal(g.author, '张三');
    assert.equal(g.title, 'feat: 配置管理');
    assert.equal(g.eventKind, 'mr');
    assert.deepEqual(g.changedFiles, ['a.yml', 'b.java']);
    assert.equal(g.sha, 'abc123');
    assert.equal(g.mrIid, 7);
  } finally {
    store.close();
  }
});

test('老记录没有快照：给 undefined，不能编一个「未记录」当项目名', () => {
  const store = new RecordStore(':memory:');
  try {
    // 模拟这一列加上之前落下的记录
    store.save(rec({ eventId: 'old' }));

    const g = store.listChanges()[0];
    assert.equal(g?.project, undefined, '当时没记就是没记 —— 补一个假值等于伪造历史');
    assert.equal(g?.title, undefined);

    // 但汇总时必须把它单独聚出来，且是空串这个可辨认的桶
    assert.equal(store.projectSummaries()[0]?.project, '');
  } finally {
    store.close();
  }
});

test('一次变更 = 一个 event：几条策略都聚回同一条，且细节一条不少', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', project: 'g/app', policyId: 'p1', outcome: 'miss', title: 't' }));
    store.save(rec({ eventId: 'e1', project: 'g/app', policyId: 'p2', outcome: 'hit', title: 't' }));
    store.save(rec({ eventId: 'e2', project: 'g/app', policyId: 'p1', outcome: 'miss', title: 't2' }));

    const changes = store.listChanges();
    assert.equal(changes.length, 2, '两次变更，不是三条判定');

    const e1 = changes.find((c) => c.eventId === 'e1');
    assert.equal(e1?.judgments.length, 2, '聚合不能把逐条判定丢掉 —— 明细只是放到第二层');
    assert.deepEqual(e1?.judgments.map((j) => j.policyId).sort(), ['p1', 'p2']);
  } finally {
    store.close();
  }
});

test('一次变更的定论取最严的那一态，不取多数', () => {
  const store = new RecordStore(':memory:');
  try {
    // 两条策略：一条说没问题、一条说没看成。多数票会把它投成 miss。
    store.save(rec({ eventId: 'e1', policyId: 'p1', outcome: 'miss' }));
    store.save(rec({ eventId: 'e1', policyId: 'p2', outcome: 'error' }));
    // 三条策略：两 miss 一 hit
    store.save(rec({ eventId: 'e2', policyId: 'p1', outcome: 'miss' }));
    store.save(rec({ eventId: 'e2', policyId: 'p2', outcome: 'miss' }));
    store.save(rec({ eventId: 'e2', policyId: 'p3', outcome: 'hit' }));

    const byId = new Map(store.listChanges().map((c) => [c.eventId, c]));
    assert.equal(byId.get('e1')?.verdict, 'error', '一条没看成，这次变更的答案就是没看成');
    assert.equal(byId.get('e2')?.verdict, 'hit', '一个命中不能被两个未命中投掉');
  } finally {
    store.close();
  }
});

test('待表态的口径与「待办」一致：命中与没做成算，未命中不算', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', policyId: 'p1', outcome: 'miss' }));
    store.save(rec({ eventId: 'e2', policyId: 'p1', outcome: 'hit' }));
    store.save(rec({ eventId: 'e3', policyId: 'p1', outcome: 'error' }));

    const byId = new Map(store.listChanges().map((c) => [c.eventId, c]));
    assert.equal(byId.get('e1')?.pending, 0, '未命中没有主张需要人确认');
    assert.equal(byId.get('e2')?.pending, 1);
    assert.equal(byId.get('e3')?.pending, 1);

    // 两个口径必须给出同一个数，否则「待办 N 条」与列表里的张数会对不上
    assert.equal(
      store.listChanges().reduce((n, c) => n + c.pending, 0),
      store.listPendingReactions().length,
    );
  } finally {
    store.close();
  }
});

test('项目视图按紧急度排：要人管的在前，判断没做成比命中更前', () => {
  const store = new RecordStore(':memory:');
  try {
    const t = (h: number) => `2026-10-15T0${h}:00:00.000Z`;
    // 一条最新的未命中、一条旧的没做成、一条中间时间的命中
    store.save(rec({ eventId: 'new-miss', project: 'g/a', outcome: 'miss', createdAt: t(9) }));
    store.save(rec({ eventId: 'old-broken', project: 'g/a', outcome: 'error', createdAt: t(2) }));
    store.save(rec({ eventId: 'mid-hit', project: 'g/a', outcome: 'hit', createdAt: t(5) }));

    assert.deepEqual(
      store.listChanges().map((c) => c.eventId),
      ['old-broken', 'mid-hit', 'new-miss'],
      '按时间排会让一个已经被合掉的旧失败沉下去，而它恰恰最需要人看见',
    );
  } finally {
    store.close();
  }
});

test('项目汇总按 event 数，不按判定条数 —— 一次变更两条策略仍是一件事', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', project: 'g/a', policyId: 'p1', outcome: 'hit' }));
    store.save(rec({ eventId: 'e1', project: 'g/a', policyId: 'p2', outcome: 'hit' }));
    store.save(rec({ eventId: 'e2', project: 'g/b', policyId: 'p1', outcome: 'miss' }));

    const s = new Map(store.projectSummaries().map((x) => [x.project, x]));
    assert.equal(s.get('g/a')?.changes, 1, '两条命中属于同一次变更');
    assert.equal(s.get('g/a')?.needAttention, 1, '要人管的是「几件事」，不是「几条判定」');
    assert.equal(s.get('g/a')?.hit, 2, '但判定条数照样要数 —— 它是策略的账');
    assert.equal(s.get('g/b')?.needAttention, 0);

    // 要人管的项目排前面
    assert.equal(store.projectSummaries()[0]?.project, 'g/a');
  } finally {
    store.close();
  }
});

test('回写过反应的变更不再算「等你表态」', () => {
  const store = new RecordStore(':memory:');
  try {
    const id = store.save(rec({ eventId: 'e1', project: 'g/a', outcome: 'hit' }));
    assert.equal(store.listChanges()[0]?.pending, 1);

    store.setReaction(id, 'adopted', '2026-10-15T05:00:00.000Z');

    assert.equal(store.listChanges()[0]?.pending, 0, '处理过了就不该还占着待办');
    assert.equal(store.projectSummaries()[0]?.needAttention, 0);
    // 但那次命中仍然在记录里 —— 「处理过」不是「没发生过」
    assert.equal(store.listChanges()[0]?.verdict, 'hit');
  } finally {
    store.close();
  }
});

test('影子判定不进项目视图 —— 它没进过人的视野', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', project: 'g/a', origin: 'shadow' }));
    assert.equal(store.listChanges().length, 0);
    assert.equal(store.projectSummaries().length, 0, '影子进了项目视图，项目上就会凭空多出没人看过的变更');
  } finally {
    store.close();
  }
});

test('快照字段坏掉时不让整个视图打不开', () => {
  const store = new RecordStore(':memory:');
  try {
    store.save(rec({ eventId: 'e1', project: 'g/a', outcome: 'hit' }));
    // 直接把 changed_files_json 写成坏 JSON —— 模拟一条坏数据
    store['db'].prepare("UPDATE judgment SET changed_files_json = '{oops' WHERE event_id = 'e1'").run();

    const g = store.listChanges()[0];
    assert.equal(g?.changedFiles, undefined, '坏数据当成「没记下来」，不抛');
    assert.equal(g?.verdict, 'hit', '其余字段照常，一次坏数据不该让列表页打不开');
  } finally {
    store.close();
  }
});
