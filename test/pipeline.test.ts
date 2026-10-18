import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CommentAction } from '../src/action/commenter.js';
import type { ActionRunner } from '../src/action/commenter.js';
import { MockEventSource } from '../src/event/mock.js';
import { StubLlmClient } from '../src/llm/stub.js';
import { runPipeline } from '../src/pipeline.js';
import {
  createClaimMismatchPolicy,
  loadClaimMismatchConfig,
} from '../src/policy/claim-mismatch.js';
import {
  createSensitivePathPolicy,
  loadSensitivePathConfig,
} from '../src/policy/sensitive-path.js';
import { globToRegExp } from '../src/policy/glob.js';
import { RecordStore } from '../src/record/store.js';

const root = process.cwd();
const config = loadSensitivePathConfig(resolve(root, 'config/sensitive-paths.json'));
const source = new MockEventSource(resolve(root, 'fixtures/events'));

function deps(outDir: string) {
  return {
    policies: [createSensitivePathPolicy(config)],
    actions: new Map([['comment', new CommentAction(outDir)]]),
    store: new RecordStore(':memory:'),
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  };
}

// ── 第一段：glob 匹配是本策略唯一的「技术风险点」，单独钉住 ──

test('glob：**/*.sql 应当同时匹配深层与顶层路径', () => {
  const re = globToRegExp('**/*.sql');
  assert.ok(re.test('backend/doc/sql/10_tables.sql'), '深层路径');
  assert.ok(re.test('10_tables.sql'), '顶层路径');
  assert.ok(!re.test('10_tables.sql.bak'), '不该匹配后缀不同的文件');
});

test('glob：**/AGENTS.md 不该匹配 AGENTS.md.bak 或子串', () => {
  const re = globToRegExp('**/AGENTS.md');
  assert.ok(re.test('AGENTS.md'));
  assert.ok(re.test('agent/AGENTS.md'));
  assert.ok(!re.test('agent/AGENTS.md.bak'));
  assert.ok(!re.test('agent/MY_AGENTS.md'));
});

// ── 四段链路 ────────────────────────────────────────────

test('命中：改动触及敏感路径时，产生动作且依据里带具体文件与规则', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-001');
  assert.ok(target, '样例事件 mock-mr-001 应当存在');

  const d = deps(resolve(root, 'var/test-comments/pipeline'));
  const result = await runPipeline(target, d);

  const verdict = result.verdicts[0]!;
  assert.equal(verdict.outcome, 'hit');
  assert.equal(result.actions.length, 1, '命中应当产生一个动作');

  const evidence = verdict.evidence;
  assert.ok(
    evidence.some((e) => e.ref === 'backend/doc/sql/10_reconciliation_tables.sql'),
    '**ref 放文件路径**，不是 glob —— 别的策略要靠它比对「是不是同一处」',
  );
  assert.ok(
    evidence.some((e) => e.detail.includes('**/*.sql')),
    '按哪条规则命中的写在 detail 里（人话那一栏）',
  );

  d.store.close();
});

test('未命中：干净的改动不报问题，但同样落记录、同样表态', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-002');
  assert.ok(target, '样例事件 mock-mr-002 应当存在');

  const d = deps(resolve(root, 'var/test-comments/pipeline'));
  const result = await runPipeline(target, d);

  assert.equal(result.verdicts[0]!.outcome, 'miss');
  assert.equal(result.recorded, 1, '未命中也要落记录 —— 否则不知道「看过但没问题」');
  assert.ok(
    result.actions[0]!.output?.includes('没有发现问题'),
    '没发现问题也要说一句 —— 否则 MR 上的沉默分不清是「过了」还是「没跑」',
  );

  d.store.close();
});

test('留痕：判断记录能从库里读回来，且依据完整', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-001')!;

  const d = deps(resolve(root, 'var/test-comments/pipeline'));
  await runPipeline(target, d);

  const rows = d.store.listRecent(10);
  assert.equal(rows.length, 1);

  const r = rows[0]!;
  assert.equal(r.eventId, 'mock-mr-001');
  assert.equal(r.policyId, 'review-sensitive-path');
  assert.equal(r.outcome, 'hit');
  assert.ok(r.reason && r.reason.length > 0, '命中时必须给出说明（主张）');

  const evidence = JSON.parse(r.evidenceJson) as unknown[];
  assert.ok(evidence.length > 0, '依据不能为空');
  assert.ok(r.createdAt.startsWith('2026-10-13'), '时间戳用的是注入的时钟');
  assert.equal(r.action, 'comment');
  assert.equal(r.actionLevel, 1);

  d.store.close();
});

test('观察期：反应可事后补填，统计只把「明确否定」单列', async () => {
  const events = await source.fetch();
  const d = deps(resolve(root, 'var/test-comments/pipeline'));

  for (const ev of events) {
    await runPipeline(ev, d);
  }

  const rows = d.store.listRecent(10);
  const hitRow = rows.find((r) => r.eventId === 'mock-mr-001')!;
  d.store.setReaction(hitRow.id!, 'rejected', '2026-10-13T13:00:00.000Z');

  const stats = d.store.statsByPolicyVersion('review-sensitive-path');
  assert.equal(stats.length, 1, '只跑过一个版本');
  const s = stats[0]!;
  assert.equal(s.total, events.length, '每个样例事件都进分母 —— 未命中的也计入');
  assert.equal(s.hit, 1);
  assert.equal(s.error, 0, '纯规则策略不会「判断没做成」');
  assert.equal(s.rejected, 1);
  assert.equal(s.adopted, 0);

  d.store.close();
});

test('一次事件只动一次手：两条策略都命中时，评论仍然只有一条', async () => {
  const events = await source.fetch();
  const base = events.find((e) => e.id === 'mock-mr-003')!;

  // 给它补一个 SQL 文件，让敏感路径那条也命中
  const event = {
    ...base,
    changedFiles: [...base.changedFiles, 'db/migration/10_login_tables.sql'],
  };

  const judgeConfig = loadClaimMismatchConfig(resolve(root, 'config/claim-mismatch.json'));
  const llm = new StubLlmClient(() =>
    JSON.stringify({
      mismatch: true,
      reason: '声称改错别字，实际改了登录鉴权',
      items: ['LoginServiceImpl 新增了账号放行分支'],
    }),
  );

  const outDir = resolve(root, 'var/test-comments/pipeline');
  const store = new RecordStore(':memory:');

  const result = await runPipeline(event, {
    policies: [createSensitivePathPolicy(config), createClaimMismatchPolicy(judgeConfig, llm)],
    actions: new Map([['comment', new CommentAction(outDir)]]),
    store,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });

  assert.equal(result.verdicts.filter((v) => v.outcome === 'hit').length, 2, '两条都该命中');
  assert.equal(result.actions.length, 1, '两条命中只该产生一次处置');

  const body = readFileSync(join(outDir, `${event.id}.md`), 'utf8');
  assert.ok(body.includes('有 2 处需要确认'), '两个问题要在同一条评论里说完');
  assert.ok(body.includes('**1. ') && body.includes('**2. '));

  // 动作只记在发起它的那条策略上 —— 记进每一条会让「被处置过几次」凭空翻倍
  const rows = store.listRecent(10);
  assert.equal(rows.length, 2, '两条策略各留一条判断记录');
  assert.equal(rows.filter((r) => r.action === 'comment').length, 1);

  store.close();
});

test('统计按版本切分：判据改版后，前后两段不能聚成一个数', () => {
  const store = new RecordStore(':memory:');
  const base = {
    eventId: 'e',
    reason: 'r',
    evidenceJson: '[]',
    origin: 'effective' as const,
    createdAt: '2026-10-13T12:00:00.000Z',
  };

  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v2', outcome: 'miss' });

  const rows = store.statsByPolicyVersion('p');
  assert.equal(
    rows.length,
    2,
    '两个版本各算一行 —— 聚成一行会把不可比的两段平均在一起，而那个数看起来更平滑、更像趋势',
  );
  assert.equal(rows[0]!.policyVersion, 'v1');
  assert.equal(rows[0]!.hit, 2);
  assert.equal(rows[1]!.policyVersion, 'v2');
  assert.equal(rows[1]!.miss, 1);

  store.close();
});

test('影子判定不进观察期的分母，也不出现在正常列表里', () => {
  const store = new RecordStore(':memory:');
  const base = {
    eventId: 'e',
    reason: 'r',
    evidenceJson: '[]',
    createdAt: '2026-10-13T12:00:00.000Z',
  };

  store.save({ ...base, policyId: 'p', policyVersion: 'v2', outcome: 'hit', origin: 'shadow' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit', origin: 'effective' });

  const rows = store.statsByPolicyVersion('p');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.policyVersion, 'v1', '影子判定那条不该被算进分母');
  assert.equal(rows[0]!.total, 1);

  assert.equal(store.listRecent(10).length, 1, '影子不进正常列表');
  assert.equal(store.listPendingReactions(10).length, 1, '影子也不会变成待回应');

  store.close();
});

test('待回应：只有「命中」与「判断没做成」进来，未命中不进', () => {
  const store = new RecordStore(':memory:');
  const base = {
    eventId: 'e',
    reason: 'r',
    evidenceJson: '[]',
    origin: 'effective' as const,
    createdAt: '2026-10-13T12:00:00.000Z',
  };

  const hitId = store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'miss' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'error' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit', origin: 'shadow' });

  assert.equal(
    store.listPendingReactions(10).length,
    2,
    '未命中是「看过，没问题」，没有主张需要人确认 —— 列进待办会把第一屏变成数据总览',
  );
  assert.equal(store.listUnresolvedErrors(10).length, 1, '判断没做成的单独拿得出来');

  store.setReaction(hitId, 'rejected', '2026-10-13T13:00:00.000Z', '模型看错了 diff');
  const after = store.findById(hitId)!;
  assert.equal(after.reaction, 'rejected');
  assert.equal(after.reactionNote, '模型看错了 diff', '「为什么」要留在库里，不只是进终端');
  assert.equal(store.listPendingReactions(10).length, 1);

  store.close();
});

test('幂等：同一事件 + 同策略 + 同版本只判一次', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-001')!;

  const store = new RecordStore(':memory:');
  const depsOnce = () => ({
    policies: [createSensitivePathPolicy(config)],
    actions: new Map<string, ActionRunner>(),
    store,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });

  const first = await runPipeline(target, depsOnce());
  assert.equal(first.recorded, 1);
  assert.equal(first.actions.length, 0, '没装动作实现时不该动作 —— 但动作缺失会由 log 说出来');

  const second = await runPipeline(target, depsOnce());
  assert.equal(
    second.recorded,
    0,
    '轮询会反复拉到同一个 MR，重复落记录会让观察期的分母凭空变大、且看不出来',
  );
  assert.equal(second.verdicts.length, 0, '已经判过的不再重新判，也就不重新动作');
  assert.equal(store.listRecent(10).length, 1);

  store.close();
});

test('统计的「看过」只算有人回过写的 —— 它才是升级判据的分母', () => {
  const store = new RecordStore(':memory:');
  const base = {
    eventId: 'e',
    reason: 'r',
    evidenceJson: '[]',
    origin: 'effective' as const,
    createdAt: '2026-10-13T12:00:00.000Z',
  };

  const a = store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'hit' });
  store.save({ ...base, policyId: 'p', policyVersion: 'v1', outcome: 'miss' });

  store.setReaction(a, 'rejected', '2026-10-13T13:00:00.000Z', '看错了 diff');

  const s = store.statsByPolicyVersion('p')[0]!;
  assert.equal(s.total, 4, '评估 = 这条策略跑过几次');
  assert.equal(s.reviewed, 1, '看过 = 其中人真的表过态的次数');
  assert.equal(s.rejected, 1);

  // 这两个数的差别就是这条改动的全部意义：用 total 当分母得出 1/4，
  // 那等于把「没人理」算成「没被推翻」；用 reviewed 才是 1/1。
  assert.equal(s.rejected / s.total, 0.25);
  assert.equal(s.rejected / s.reviewed, 1);

  store.close();
});

test('回滚：外部引用与撤销时刻都能落库、读回，且撤销不删记录', () => {
  const store = new RecordStore(':memory:');
  const base = {
    eventId: 'gitlab-my-group-my-app-7-abc123def456',
    policyId: 'p',
    policyVersion: 'v1',
    outcome: 'hit' as const,
    reason: 'r',
    evidenceJson: '[]',
    origin: 'effective' as const,
    createdAt: '2026-10-14T12:00:00.000Z',
  };

  const withRef = store.save({ ...base, action: 'comment', actionLevel: 1, externalRef: '4321' });
  const noRef = store.save({ ...base, action: 'comment', actionLevel: 1 });

  assert.equal(store.findExternalRef(withRef)!.externalRef, '4321');
  assert.equal(store.findExternalRef(withRef)!.undoneAt, undefined, '还没撤过');
  assert.equal(
    store.findExternalRef(noRef)!.externalRef,
    undefined,
    '干燥跑的动作没有外部引用 —— 撤销那边会据此拒绝，而不是猜',
  );

  store.setUndone(withRef, '2026-10-14T13:00:00.000Z');

  const after = store.findById(withRef)!;
  assert.equal(after.undoneAt, '2026-10-14T13:00:00.000Z');
  assert.equal(after.action, 'comment', '撤销不删记录 —— 「发出去了又收回」本身该看得见');
  assert.equal(store.listRecent(10).length, 2, '两条都还在');

  store.close();
});

test('触发条件：不通过就静默跳过，且要说清是哪一条卡的', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-002')!; // 改的是前端文件

  const store = new RecordStore(':memory:');
  const depsOf = (pathGlobs?: string[]) => ({
    // 一条只关心 SQL 文件的策略 —— 对这个事件不感兴趣
    policies: [
      {
        ...createSensitivePathPolicy({
          ...config,
          paths: [{ glob: '**/*.sql', label: '库表 SQL' }],
        }),
        ...(pathGlobs ? { trigger: { pathGlobs } } : {}),
      },
    ],
    actions: new Map<string, ActionRunner>(),
    store,
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  });

  // 有触发条件，且不通过 → 静默跳过
  const skipped = await runPipeline(target, depsOf(['**/*.sql']));
  assert.equal(skipped.verdicts.length, 0, '触发不通过 = 没评估');
  assert.equal(skipped.recorded, 0, '不落记录 —— 它不代表任何判断');
  assert.equal(skipped.skippedByTrigger.length, 1);
  assert.ok(
    skipped.skippedByTrigger[0]!.reason.includes('没有文件匹配'),
    '要说清是哪一条卡的 —— 否则「这条策略从没跑过」只能靠猜',
  );

  // 对照组：同一条策略、同一个事件，只是**没有触发条件** → 它就评估了
  const evaluated = await runPipeline(target, depsOf());
  assert.equal(evaluated.verdicts.length, 1, '没有触发条件 = 每个事件都触发');
  assert.equal(evaluated.skippedByTrigger.length, 0);

  store.close();
});

test('旁证：别的策略指向同一个文件才算，指向别处不算', () => {
  const store = new RecordStore(':memory:');
  const at = '2026-10-14T12:00:00.000Z';
  const ev = (files: string[]) =>
    JSON.stringify(files.map((f) => ({ kind: 'changed_file', detail: f, ref: f })));

  const base = {
    outcome: 'hit' as const,
    reason: 'r',
    origin: 'effective' as const,
    createdAt: at,
  };

  // 同一个事件上，两条策略都命中，且都指向 a.ts
  const a = store.save({ ...base, eventId: 'e1', policyId: 'p1', policyVersion: 'v1', evidenceJson: ev(['a.ts']) });
  store.save({ ...base, eventId: 'e1', policyId: 'p2', policyVersion: 'v1', evidenceJson: ev(['a.ts', 'b.ts']) });

  const c = store.corroborationOf(a);
  assert.deepEqual(c.checked, ['a.ts'], '共同锚是文件路径');
  assert.deepEqual(c.by, ['p2'], '给出是哪条策略');
  assert.ok(!c.checked.includes('b.ts'), '只有它自己指向的文件不算旁证');

  // 同一个事件、别的策略命中，但指向的是别的文件 → 没有旁证
  const d = store.save({ ...base, eventId: 'e2', policyId: 'p1', policyVersion: 'v1', evidenceJson: ev(['c.ts']) });
  store.save({ ...base, eventId: 'e2', policyId: 'p2', policyVersion: 'v1', evidenceJson: ev(['d.ts']) });

  assert.deepEqual(store.corroborationOf(d), { checked: [], by: [] });

  // 单条策略（没有别的视角）→ 永远没有旁证，不该凭空造一个出来
  const solo = store.save({ ...base, eventId: 'e3', policyId: 'p1', policyVersion: 'v1', evidenceJson: ev(['x.ts']) });
  assert.deepEqual(store.corroborationOf(solo), { checked: [], by: [] });

  store.close();
});

test('旁证：证据 JSON 坏掉时不抛，返回空 —— 一条坏数据不该把列表页打挂', () => {
  const store = new RecordStore(':memory:');
  const at = '2026-10-14T12:00:00.000Z';

  const a = store.save({
    eventId: 'e1', policyId: 'p1', policyVersion: 'v1', outcome: 'hit',
    reason: 'r', evidenceJson: '这不是 JSON', origin: 'effective', createdAt: at,
  });
  store.save({
    eventId: 'e1', policyId: 'p2', policyVersion: 'v1', outcome: 'hit',
    reason: 'r', evidenceJson: '{也坏了', origin: 'effective', createdAt: at,
  });

  assert.deepEqual(store.corroborationOf(a), { checked: [], by: [] });
  assert.deepEqual(store.corroborationOf(9999), { checked: [], by: [] }, '记录不存在也给空，不抛');

  store.close();
});

test('动作：评论正文把结论与依据分开呈现，并注明是哪条策略下的判断', async () => {
  const events = await source.fetch();
  const target = events.find((e) => e.id === 'mock-mr-001')!;

  const outDir = resolve(root, 'var/test-comments/pipeline');
  const d = deps(outDir);
  await runPipeline(target, d);

  const body = readFileSync(join(outDir, 'mock-mr-001.md'), 'utf8');
  assert.ok(body.includes('有 1 处需要确认'), '开头要说清这次有几处');
  assert.ok(body.includes('**1. '), '结论单独成段，人扫一眼就能看到');
  assert.ok(body.includes('10_reconciliation_tables.sql'), '依据里要有具体文件');
  assert.ok(body.includes('`changed_file`'), '依据要标出种类');
  assert.ok(body.includes('review-sensitive-path'), '要注明是哪条策略、哪个版本');
  assert.ok(body.includes('处置级别 1'), '要注明处置级别（当前是观察期的一级）');

  d.store.close();
});
