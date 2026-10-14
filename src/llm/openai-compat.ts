import type { LlmClient, LlmRequest, LlmResponse } from './client.js';

export interface OpenAiCompatConfig {
  /** 形如 https://api.deepseek.com/v1 —— 结尾有没有斜杠都行 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 判据要的是可复现，所以默认 0 */
  temperature?: number;
  timeoutMs?: number;
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
