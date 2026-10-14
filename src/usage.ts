import type { ModelUsage } from './types.js';

/**
 * 用量的解析与渲染 —— 三条读通路（CLI / MCP / 控制台）共用。
 *
 * **为什么要有这个文件**：判据只该有一处。三处各写一遍，迟早会有一处把
 * 「没有思考」显示成「思考 0 token」—— 而那两个意思完全不同：前者是
 * 「这次调用里根本没有思维链」，后者是「想了，但一个 token 都没花」，
 * 后者不存在。
 */

/**
 * 把记录里存的用量 JSON 解析回来。
 *
 * 解析不了时**抛给调用方一句话**，而不是返回 undefined —— 返回空值会让
 * 「这条记录没有用量」与「用量坏了」长得一模一样，那正是这个平台在防的事。
 */
export function parseUsage(usageJson: string | undefined): ModelUsage | undefined {
  if (usageJson === undefined || usageJson === '') return undefined;

  try {
    return JSON.parse(usageJson) as ModelUsage;
  } catch {
    // 坏数据不该把整个列表页打挂（同 store.ts 的 changedFilesOf），
    // 所以这里给一个能读的对象，把那件事说出来
    return { raw: usageJson };
  }
}

/** 一行人话。没有用量时返回 undefined —— 调用方据此决定要不要打这一行。 */
export function describeUsage(usage: ModelUsage | undefined): string | undefined {
  if (!usage) return undefined;
  if (usage.promptTokens === undefined && usage.completionTokens === undefined) {
    return '（这条记录的用量读不出来 —— 那是数据问题，不是「没有用量」）';
  }

  const parts: string[] = [];
  if (usage.promptTokens !== undefined) parts.push(`输入 ${usage.promptTokens}`);
  if (usage.completionTokens !== undefined) parts.push(`输出 ${usage.completionTokens}`);
  parts.push(
    usage.reasoningTokens !== undefined
      ? `思考 ${usage.reasoningTokens}`
      : '没有思考（响应里没有 reasoning_tokens 字段）',
  );

  return parts.join(' · ');
}
