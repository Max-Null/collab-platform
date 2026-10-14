import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OpenAiCompatLlmClient } from '../src/llm/openai-compat.js';
import { createLlm } from '../src/wiring.js';

/**
 * 这一组测模型装配里的**配置读取**。
 *
 * 三个必给的变量缺了要如实报「没配置」（而不是拿桩假装判断过了）；
 * 三个可选项配错了要在**装配期**报错 —— 不能静默回落到默认：
 * 回落的表现是「配置写了但没生效」，那与「没写」长得一模一样。
 */

const KEYS = [
  'LLM_BASE_URL',
  'LLM_API_KEY',
  'LLM_MODEL',
  'LLM_TEMPERATURE',
  'LLM_TIMEOUT_MS',
  'LLM_EXTRA_BODY',
] as const;

/** 模块加载时的真实环境，逐个还原 —— 免得污染同一进程里的其它用例 */
const snapshot = new Map(KEYS.map((k) => [k, process.env[k]]));

function useEnv(env: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v as string;
}

afterEach(() => {
  for (const k of KEYS) {
    const v = snapshot.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('三个必给的缺一个就算「没配置」—— 桩要抛错，不假装判断过了', () => {
  useEnv({ LLM_BASE_URL: 'https://api.deepseek.com' });
  assert.equal(createLlm().configured, false);
});

test('配齐三个就是配置好了', () => {
  useEnv({
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'deepseek-flash',
  });

  const { configured, client } = createLlm();
  assert.equal(configured, true);
  assert.equal(client.model, 'deepseek-flash');
});

test('LLM_TEMPERATURE 不是数字：装配期报错，不静默当没配', () => {
  useEnv({
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'deepseek-flash',
    LLM_TEMPERATURE: 'warm',
  });
  assert.throws(() => createLlm(), /LLM_TEMPERATURE 不是数字/);
});

test('LLM_EXTRA_BODY 是坏 JSON：装配期报错', () => {
  useEnv({
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'deepseek-flash',
    LLM_EXTRA_BODY: '{"thinking":',
  });
  assert.throws(() => createLlm(), /LLM_EXTRA_BODY 不是合法 JSON/);
});

test('LLM_EXTRA_BODY 不是对象（数组 / 字面量）：装配期报错', () => {
  const base = {
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_API_KEY: 'k',
    LLM_MODEL: 'deepseek-flash',
  };

  useEnv({ ...base, LLM_EXTRA_BODY: '[1,2]' });
  assert.throws(() => createLlm(), /必须是一个 JSON 对象/);

  useEnv({ ...base, LLM_EXTRA_BODY: '"enabled"' });
  assert.throws(() => createLlm(), /必须是一个 JSON 对象/);
});

test('extraBody 原样合并进请求体，且能覆盖默认值', async () => {
  const originalFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ model: 'deepseek-flash', choices: [{ message: { content: '{}' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    const client = new OpenAiCompatLlmClient({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'k',
      model: 'deepseek-flash',
      extraBody: { thinking: { type: 'disabled' }, temperature: 0.7 },
    });
    await client.complete({ system: 's', prompt: 'p', json: true });

    assert.deepEqual(sent?.thinking, { type: 'disabled' }, '厂商特有的参数要原样进去');
    assert.equal(sent?.temperature, 0.7, 'extraBody 放在最后，要能覆盖默认的 0');
    assert.deepEqual(sent?.response_format, { type: 'json_object' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
