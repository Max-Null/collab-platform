import type { ChangeEvent } from '../types.js';

/**
 * 事件源。
 *
 * 做成接口是为了可插拔：第一版用 mock（本地样例事件），
 * 接入真实 GitLab 时只需再实现一个 GitLabEventSource，管道不用改。
 *
 * 不急着接真实 GitLab 的原因：在真仓库里试会留下一堆垃圾评论。
 */
export interface EventSource {
  readonly name: string;
  fetch(): Promise<ChangeEvent[]>;
}
