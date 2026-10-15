import type { GitLabApi } from '../gitlab/api.js';
import type { ChangeEvent } from '../types.js';
import type { EventSource } from './source.js';

/**
 * GitLab 推送（分支提交）事件源。
 *
 * **为什么必须有它**：另一个事件源只订阅 MR，而真实团队几乎不用 MR ——
 * 三个仓库合计 3 条 MR，提交却是活跃的。只认 MR 的后果不是「少看到一点」，
 * 是**看不到绝大多数变更**；而且平台对此**毫无察觉**：每轮都成功、每轮都是
 * 0 个事件，「在跑」与「在看」被混成了同一件事。这正是平台要防的那类失效，
 * 只不过这次它出现在平台自己身上。
 *
 * 单元取**提交**而不是「一次推送」：轮询看不到推送这个动作的边界，只能看到
 * 「分支现在在哪」。以提交为单元还有个好处 —— 事件 id 里带 sha，于是
 * 「这个提交被审过没有」有答案；而新推一个 sha，就是一次新事件。
 *
 * **主张从哪来**：对 MR 是人工写的标题与描述，对提交是**提交消息**。
 * 所以「改动与声称是否相符」在推送上照样能跑，只不过主张通常更短、
 * 更少被认真写 —— 那会影响它的命中率，但那是要靠观察期数据说话的事，
 * 不该靠「干脆不跑它」来回避（那就又回到「静默地少看一部分」了）。
 */
export class GitLabPushSource implements EventSource {
  readonly name = 'gitlab-push';

  constructor(
    private readonly api: GitLabApi,
    private readonly project: string,
    private readonly opts: { branch?: string; limit?: number } = {},
  ) {}

  async fetch(): Promise<ChangeEvent[]> {
    const commits = await this.api.listCommits(this.project, {
      refName: this.opts.branch,
      limit: this.opts.limit,
    });

    const events: ChangeEvent[] = [];

    for (const c of commits) {
      // 合并提交跳过：它的 diff 是被合进来的那些改动的合集，而那些提交各自
      // 也已经报过一次。不跳过就会把同一处变更判两遍 —— 观察期的分母最怕重复计数，
      // 而重复计数看起来只是「数据更多了」。
      if ((c.parent_ids?.length ?? 0) > 1) continue;

      const changes = await this.api.fetchCommitChanges(this.project, c.id);
      const rest = c.message.split('\n').slice(1).join('\n').trim();

      events.push({
        id: `gitlab-push-${this.project.replace(/[^\w]+/g, '-')}-${c.short_id}`,
        source: 'gitlab',
        kind: 'push',
        project: this.project,
        // 没有 mrIid —— 推送没有可评论的落点，动作层会如实把这一点报出来
        sha: c.id,
        title: c.title,
        // 描述取提交消息的**其余部分**：第一行就是 title，照搬会让判据把同一句话读两遍，
        // 而那会让一次「只在标题里写了什么」的改动看起来像说了两遍
        description: rest,
        author: c.author_name,
        targetBranch: this.opts.branch ?? '',
        changedFiles: changes.changedFiles,
        diff: changes.diff,
        occurredAt: c.committed_date,
      });
    }

    return events;
  }
}
