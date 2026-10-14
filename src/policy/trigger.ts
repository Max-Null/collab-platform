import type { ChangeEvent, PolicyTrigger } from '../types.js';
import { globToRegExp } from './glob.js';

/**
 * 这条策略对这个事件感不感兴趣。
 *
 * 刻意返回**理由**而不只是布尔：一条策略长期没触发过时，最要紧的问题是
 * 「它为什么不触发」—— 是路径写窄了、分支对不上、还是根本没人提过这类变更。
 * 只说「没触发」答不了这个问题，而答不了就只能靠猜。
 */
export interface TriggerDecision {
  matched: boolean;
  /** 没匹配时是哪一条卡的 */
  reason?: string;
}

export function checkTrigger(
  trigger: PolicyTrigger | undefined,
  event: ChangeEvent,
): TriggerDecision {
  if (!trigger) return { matched: true };

  if (trigger.sources && trigger.sources.length > 0 && !trigger.sources.includes(event.source)) {
    return { matched: false, reason: `事件来源 ${event.source} 不在 ${trigger.sources.join('/')}` };
  }

  if (trigger.targetBranch && event.targetBranch !== trigger.targetBranch) {
    return {
      matched: false,
      reason: `目标分支 ${event.targetBranch || '（空）'} ≠ ${trigger.targetBranch}`,
    };
  }

  if (
    trigger.minChangedFiles !== undefined &&
    event.changedFiles.length < trigger.minChangedFiles
  ) {
    return {
      matched: false,
      reason: `改动文件 ${event.changedFiles.length} 个 < ${trigger.minChangedFiles}`,
    };
  }

  if (trigger.pathGlobs && trigger.pathGlobs.length > 0) {
    const rules = trigger.pathGlobs.map((g) => ({ g, re: globToRegExp(g) }));
    const hit = event.changedFiles.find((f) => rules.some((r) => r.re.test(f)));

    if (!hit) {
      return {
        matched: false,
        reason: `没有文件匹配 ${trigger.pathGlobs.join(' / ')}`,
      };
    }
  }

  return { matched: true };
}
