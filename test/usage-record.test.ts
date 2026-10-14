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
import { parseUsage } from '../src/usage.js';

/**
 * 用量从模型响应一路走到判断记录的**端到端**验证。
 *
 * 为什么这条必测：用量是「这次判断花了多少、在什么模式下判的」的唯一证据，
 * 而它**随配置变** —— 落不进记录，历史就再也说不出自己是怎么产生的。
 * 单测只能证明零件对；链路上少接一根线，零件测试照样全绿。
 */

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

test('用量：模型报的 token 数要一路进到判断记录里', async () => {
  const llm = new StubLlmClient(() => ({
    text: JSON.stringify({ mismatch: false, reason: '改动与声称一致', items: [] }),
    usage: {
      promptTokens: 1200,
      completionTokens: 64,
      reasoningTokens: 64,
      raw: { prompt_tokens: 1200, completion_tokens: 64 },
    },
  }));

  const d = deps(llm);
  await runPipeline(await mr003(), d);

  const record = d.store.listRecent(1)[0];
  assert.ok(record, '应当落了一条记录');
  assert.ok(record.usageJson, '用量要进记录');

  const usage = parseUsage(record.usageJson);
  assert.equal(usage?.promptTokens, 1200);
  assert.equal(usage?.reasoningTokens, 64, '思考 token 数就是「这次有没有思考」的答案');

  d.store.close();
});

test('用量：模型没报用量时记录里留空 —— 不编一个零出来', async () => {
  const llm = new StubLlmClient(() =>
    JSON.stringify({ mismatch: false, reason: '一致', items: [] }),
  );

  const d = deps(llm);
  await runPipeline(await mr003(), d);

  const record = d.store.listRecent(1)[0];
  assert.equal(record?.usageJson, undefined, '「没有这次调用」与「这次调用花了零」是两件事');

  d.store.close();
});
