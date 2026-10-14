/**
 * 模型调用接口。
 *
 * 平台不绑定任何一家模型 —— 「调哪家」是配置，不是代码。
 * 这一层抽象还有第二个存在理由：**测试不能依赖网络**，
 * 判据的逻辑必须能在桩上跑完，否则每次改判据都要真花钱调模型。
 */

import type { ModelUsage } from '../types.js';

export interface LlmRequest {
  /** 系统提示词 —— 放判据里不变的那部分 */
  system: string;
  /** 用户消息 —— 放这一次的具体材料 */
  prompt: string;
  /** 要求结构化输出时置位，客户端据此选择 JSON 模式 */
  json?: boolean;
}

export interface LlmResponse {
  text: string;
  /** 实际响应的模型名 —— 留痕要记清是哪家模型做的判断 */
  model: string;
  /**
   * 这次调用的用量（各家字段形状不一，见 types.ts 的 ModelUsage）。
   *
   * 客户端拿不到时就留空 —— 不编一个零出来。留空与「zero tokens」是两件事，
   * 而那个区别正是这个平台反复在守的那条线。
   */
  usage?: ModelUsage;
}

export interface LlmClient {
  /** 客户端名字，进留痕 */
  readonly name: string;
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}
