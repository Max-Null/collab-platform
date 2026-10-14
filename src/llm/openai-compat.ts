import type { LlmClient, LlmRequest, LlmResponse } from './client.js';

export interface OpenAiCompatConfig {
  /** 形如 https://api.deepseek.com —— 结尾有没有斜杠都行 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * 判据要的是可复现，所以默认 0。
   *
   * ⚠️ **支持思考模式的厂商会忽略它。** DeepSeek 文档的原话是「思考模式不支持
   * temperature …… 设置参数不会报错，但也不会生效」。所以默认 0 在思考模式下
   * 是个**摆设** —— 别把它当成确定性的保证（那种「看起来稳、实则无保证」正是
   * 这个平台在防的东西）。想要它生效，得先把思考关掉。
   */
  temperature?: number;
  timeoutMs?: number;
  /**
   * 厂商特有的请求参数，原样合并进请求体（放在最后，可以覆盖上面的默认值）。
   *
   * 为什么是透传而不是具名字段：各家的思考控制参数名与取值都不一样 ——
   * DeepSeek 是 `{"thinking":{"type":"enabled"},"reasoning_effort":"high"}`，
   * 百炼是 `{"enable_thinking":true,"thinking_budget":500}`。为某一家写死字段名，
   * 等于替使用方选定了厂商，与「调哪家是配置，不是代码」（见 client.ts）冲突。
   */
  extraBody?: Record<string, unknown>;
}

/**
 * OpenAI 兼容的 chat/completions 客户端。
 *
 * 用 `fetch`（Node 22 内置）+ `AbortSignal.timeout`，不引第三方 SDK ——
 * 与平台「零第三方运行时依赖」的约定一致。
 */
export class OpenAiCompatLlmClient implements LlmClient {
  readonly name = 'openai-compat';
  readonly model: string;

  constructor(private readonly cfg: OpenAiCompatConfig) {
    this.model = cfg.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.prompt },
        ],
        temperature: this.cfg.temperature ?? 0,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        // 厂商特有的参数放最后 —— 它要能覆盖上面那几个默认值，否则「透传」是假的
        ...this.cfg.extraBody,
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`模型返回 HTTP ${res.status}：${body.slice(0, 500)}`);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      model?: string;
    };
    const text = data.choices?.[0]?.message?.content;

    if (typeof text !== 'string') {
      throw new Error(`模型响应里没有 content：${JSON.stringify(data).slice(0, 500)}`);
    }
    return { text, model: data.model ?? this.cfg.model };
  }
}
