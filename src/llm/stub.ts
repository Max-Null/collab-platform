import type { ModelUsage } from '../types.js';
import type { LlmClient, LlmRequest, LlmResponse } from './client.js';

/**
 * 测试桩。
 *
 * 它不是「假实现」—— 它接一个真实的响应函数，因此测试可以精确构造
 * 「模型这么说」的场景（包括说胡话、返回半截 JSON、直接抛错），
 * 而不必真去调模型。`calls` 留着回答另一个问题：**判据到底给模型看了什么**
 * —— 这是「主张不能进依据」那条边界唯一可断言的地方。
 *
 * 响应函数可以返回字符串（只有正文），也可以返回 `{ text, usage }` ——
 * 后者用来构造「这次调用花了多少 token」的场景，那是留痕用例需要的。
 */
export class StubLlmClient implements LlmClient {
  readonly name = 'stub';
  readonly model = 'stub';
  readonly calls: LlmRequest[] = [];

  constructor(
    private readonly responder: (req: LlmRequest) => string | { text: string; usage?: ModelUsage },
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const out = this.responder(req);

    return typeof out === 'string'
      ? { text: out, model: this.model }
      : { text: out.text, model: this.model, usage: out.usage };
  }
}
