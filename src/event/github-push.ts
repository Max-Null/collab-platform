import type { GitHubApi } from '../github/api.js';
import type { ChangeEvent } from '../types.js';
import type { EventSource } from './source.js';

/**
 * GitHub 推送（分支提交）事件源。
 *
 * 与 `gitlab-push.ts` 同一条设计，理由也一样：只订阅 PR 的平台，在团队直接推分支时
 * 「每轮成功、每轮 0 个事件」—— 而那与「真的没有变更」分不开。
 *
 * **主张从哪儿来**：对 PR 是标题与正文，对提交是**提交消息**。
 * 标题取第一行，描述取其余部分 —— 第一行照搬会让判据把同一句话读两遍。
 *
 * ⚠️ **合并提交要跳过。** 它的 diff 是被合进来那些改动的合集，而那些提交
 * 各自也会被列出来 —— 不跳过就是把同一处变更判两遍，而观察期的分母最怕重复计数。
 * GitHub 用 `parents.length > 1` 判断，与 GitLab 的 `parent_ids.length > 1` 等价。
 */
export class GitHubPushSource implements EventSource {
  readonly name = 'github-push';

  constructor(
    private readonly api: GitHubApi,
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
      if ((c.parents?.length ?? 0) > 1) continue;

      const changes = await this.api.fetchCommitChanges(this.project, c.sha);
      const message = c.commit.message ?? '';
      const firstLine = message.split('\n')[0] ?? '';
      const rest = message.split('\n').slice(1).join('\n').trim();

      events.push({
        // 事件 id 用完整 sha：一个 sha 就是一次事件，新推一个 sha 就是新事件。
        // 这里不复用「短 id」—— 短 sha 在高频仓库里有碰撞的可能，
        // 而一旦撞上，后果是「这次的判定被当成上次的」悄悄跳过。
        id: `github-push-${this.project.replace(/[^\w]+/g, '-')}-${c.sha}`,
        source: 'github',
        kind: 'push',
        project: this.project,
        // 没有 mrIid —— 推送没有可评论的落点，动作层会如实把这一点报出来
        sha: c.sha,
        title: firstLine,
        description: rest,
        author: c.commit.author?.name ?? 'unknown',
        targetBranch: this.opts.branch ?? '',
        changedFiles: changes.changedFiles,
        diff: changes.diff,
        occurredAt: c.commit.author?.date ?? new Date(0).toISOString(),
      });
    }

    return events;
  }
}
