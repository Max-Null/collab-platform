import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { CommentAction } from '../src/action/commenter.js';
import { MockEventSource } from '../src/event/mock.js';
import { StubLlmClient } from '../src/llm/stub.js';
import { runPipeline } from '../src/pipeline.js';
import {
  createClaimMismatchPolicy,
  loadClaimMismatchConfig,
} from '../src/policy/claim-mismatch.js';
import { RecordStore } from '../src/record/store.js';

const root = process.cwd();
const config = loadClaimMismatchConfig(resolve(root, 'config/claim-mismatch.json'));
const source = new MockEventSource(resolve(root, 'fixtures/events'));

async function mr003() {
  const events = await source.fetch();
  const event = events.find((e) => e.id === 'mock-mr-003');
  assert.ok(event, '样例事件 mock-mr-003 应当存在');
  return event;
}

function deps(llm: StubLlmClient) {
  return {
    policies: [createClaimMismatchPolicy(config, llm)],
    actions: new Map([['comment', new CommentAction(resolve(root, 'var/test-comments'))]]),
    store: new RecordStore(':memory:'),
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  };
}

function llmSaying(payload: unknown): StubLlmClient {
  return new StubLlmClient(() => JSON.stringify(payload));
}

// ── 这条策略的核心边界：依据 vs 主张 ────────────────────

test('边界：gather 白名单里写「主张」（标题 / 描述）会被装配期直接拒绝', () => {
  const llm = llmSaying({ mismatch: false, reason: '', items: [] });

  for (const claim of ['title', 'description']) {
    assert.throws(
      () => createClaimMismatchPolicy({ ...config, gather: ['changed_files', claim] }, llm),
      /属于主张而不是依据/,
      `${claim} 由提交者自己写、随时可以改，不能作为依据`,
    );
  }
});

test('边界：gather 白名单里的未知来源被拒绝，而不是运行时静默取空', () => {
  const llm = llmSaying({ mismatch: false, reason: '', items: [] });
  assert.throws(() => createClaimMismatchPolicy({ ...config, gather: ['commits'] }, llm), /未知来源/);
});

test('边界：主张仍然要给模型看（要检验就得看得见），但被明确标成非依据', async () => {
  const llm = llmSaying({ mismatch: false, reason: '改动与声称一致', items: [] });
  const d = deps(llm);
  await runPipeline(await mr003(), d);

  assert.equal(llm.calls.length, 1);
  const prompt = llm.calls[0]!.prompt;
  assert.ok(prompt.includes('修正几个错别字'), '标题要进 prompt');
  assert.ok(prompt.includes('仅供检验，不作为事实依据'), '主张必须被标注');
  assert.ok(prompt.includes('【实际改动】（客观事实）'), '事实段要在');
  assert.ok(prompt.includes('LoginServiceImpl.java'), 'diff 要进 prompt');

  d.store.close();
});

// ── 三态 ────────────────────────────────────────────────

test('命中：模型说对不上 → 命中，依据里注明取数与模型出处', async () => {
  const llm = llmSaying({
    mismatch: true,
    reason: '声称只改错别字，实际动了登录放行逻辑',
    items: ['LoginServiceImpl.login 里新增了账号锁定状态的放行分支'],
  });
  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  const verdict = result.verdicts[0]!;
  assert.equal(verdict.outcome, 'hit');
  assert.equal(result.actions.length, 1, '命中应当产生动作');
  assert.ok(
    verdict.evidence.some((e) => e.kind === 'model'),
    '依据里要注明是哪家模型判断的',
  );
  assert.ok(
    verdict.evidence.some((e) => e.kind === 'gather'),
    '依据里要注明取到了哪些数',
  );

  d.store.close();
});

test('未命中：模型说对得上 → 不报问题，但仍然表态', async () => {
  const llm = llmSaying({ mismatch: false, reason: '改动与声称一致', items: [] });
  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  assert.equal(result.verdicts[0]!.outcome, 'miss');
  assert.equal(result.recorded, 1);
  assert.ok(
    result.actions[0]!.output?.includes('没有发现问题'),
    '没发现问题也要说一句 —— 否则 MR 上的沉默分不清是「过了」还是「没跑」',
  );

  d.store.close();
});

test('判断没做成：模型调用失败 → error，评论里明说「这不等于通过」', async () => {
  const llm = new StubLlmClient(() => {
    throw new Error('连接超时');
  });
  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  const verdict = result.verdicts[0]!;
  assert.equal(verdict.outcome, 'error', '失败不等于通过');
  assert.ok(verdict.reason?.includes('连接超时'));
  assert.ok(
    result.actions[0]!.output?.includes('这不等于通过'),
    '判断没做成必须在 MR 上被看见，不能只躺在平台的记录里',
  );

  d.store.close();
});

test('判断没做成：模型返回的不是 JSON → error，而不是猜一个结论', async () => {
  const llm = new StubLlmClient(() => '看起来没问题，改得挺好。');
  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  assert.equal(result.verdicts[0]!.outcome, 'error');
  assert.ok(result.actions[0]!.output?.includes('没有做成判断'));

  d.store.close();
});

test('取数失败：事件里没有 diff 时不判断，也不冒充「没问题」', async () => {
  const llm = llmSaying({ mismatch: false, reason: '', items: [] });
  const event = await mr003();
  delete event.diff;

  const d = deps(llm);
  const result = await runPipeline(event, d);

  const verdict = result.verdicts[0]!;
  assert.equal(verdict.outcome, 'error');
  assert.ok(verdict.reason?.includes('diff'), '要说清是哪个来源取不到');
  assert.equal(llm.calls.length, 0, '取不到数就不该调模型');
  assert.ok(result.actions[0]!.output?.includes('这不等于通过'));

  d.store.close();
});

test('取到了但是空的：没有改动的 MR 也不判断，且措辞与「取不到」分得开', async () => {
  const llm = llmSaying({ mismatch: false, reason: '', items: [] });
  const event = { ...(await mr003()), changedFiles: [], diff: '' };

  const d = deps(llm);
  const result = await runPipeline(event, d);

  const verdict = result.verdicts[0]!;
  assert.equal(verdict.outcome, 'error');
  assert.ok(
    verdict.reason?.includes('取到了但是空的'),
    '空改动与取数失败是两回事 —— 事后看记录的人要能一眼分清',
  );
  assert.equal(llm.calls.length, 0);

  d.store.close();
});

test('条件成立：结论带前提时，前提要一路带到留痕与评论里', async () => {
  const llm = llmSaying({
    mismatch: true,
    reason: '声称只改文案，实际动了登录逻辑',
    precondition: '仅在 MR 描述写得过于简略时成立；描述详细时可能是误报',
    items: ['LoginServiceImpl 新增了放行分支'],
  });

  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  assert.equal(result.verdicts[0]!.outcome, 'hit', '有条件才成立的命中**仍然是命中**');
  assert.ok(
    result.verdicts[0]!.precondition?.includes('描述写得过于简略'),
    '前提不能在中途丢掉 —— 丢掉它，人看到的就是一条无条件的结论',
  );
  assert.ok(
    result.actions[0]!.output?.includes('成立前提'),
    '评论里要写出来：人对着一条条件结论，只答「对/不对」是没有意义的',
  );

  const row = d.store.listRecent(1)[0]!;
  assert.ok(row.precondition?.includes('描述写得过于简略'), '留痕里也要有');

  d.store.close();
});

test('条件成立：模型给空串就当没有前提，不显示成人话里的空白', async () => {
  const llm = llmSaying({
    mismatch: true,
    reason: '对不上',
    precondition: '   ',
    items: [],
  });

  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  assert.equal(result.verdicts[0]!.outcome, 'hit');
  assert.equal(result.verdicts[0]!.precondition, undefined, '空串等于没有');
  assert.ok(!result.actions[0]!.output?.includes('成立前提'));

  d.store.close();
});

test('留痕：「判断没做成」在统计里单列，不混进未命中', async () => {
  const llm = new StubLlmClient(() => {
    throw new Error('模型不可用');
  });
  const d = deps(llm);
  await runPipeline(await mr003(), d);

  const s = d.store.statsByPolicyVersion('review-claim-mismatch');
  assert.equal(s.length, 1, '只跑过一个版本');
  assert.equal(s[0]!.total, 1);
  assert.equal(s[0]!.hit, 0);
  assert.equal(s[0]!.error, 1, 'error 必须单独可见 —— 否则失败会被读成干净');

  d.store.close();
});

test('模型把 JSON 包在代码块里也解析得出来', async () => {
  const llm = new StubLlmClient(
    () => '```json\n{"mismatch": true, "reason": "对不上", "items": ["a"]}\n```',
  );
  const d = deps(llm);
  const result = await runPipeline(await mr003(), d);

  assert.equal(result.verdicts[0]!.outcome, 'hit');

  d.store.close();
});
