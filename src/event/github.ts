import type { GitHubApi } from '../github/api.js';
import type { ChangeEvent } from '../types.js';
import type { EventSource } from './source.js';

/**
 * GitHub 轮询事件源（PR）。
 *
 * 与 `gitlab.ts` 是同一条设计，三条理由也一模一样：轮询只要只读 token、
 * 不产生任何写操作、不需要仓库管理员配任何东西。这里只写 GitHub 特有的那几点。
 *
 * ⚠️ **PR 的「声称」藏在两个字段里**：`title` 与 `body`。而 body 常常是空的
 * （有人只写标题就提了 PR），标题又常常是模板化的 `chore: ...`。
 * 这不影响它能不能被检验 —— 它照样是主张，只是短。判据若因此判不准，
 * 那是观察期该记录的事，不是在这里替它抹平。
 *
 * ⚠️ **draft PR 也当事件**。它会一直停在 draft，但改动是真实的；
 * 而且「一个挂了三个月的 draft」本身就是值得看一眼的东西。
 */
export class GitHubPullSource implements EventSource {
  readonly name = 'github';

  constructor(
    private readonly api: GitHubApi,
    private readonly project: string,
    private readonly opts: { limit?: number; state?: string } = {},
  ) {}

  async fetch(): Promise<ChangeEvent[]> {
    const prs = await this.api.listPullRequests(this.project, this.opts);
    const events: ChangeEvent[] = [];

    for (const pr of prs) {
      const changes = await this.api.fetchChanges(this.project, pr.number);

      events.push({
        // 事件 id 带 head sha：同一个 PR 改一版就是一次新事件。
        // ——「这个版本被审过没有」要有答案，而不是「这个 PR 被审过没有」。
        id: `github-${this.project.replace(/[^\w]+/g, '-')}-pr-${pr.number}-${pr.head.sha.slice(0, 8)}`,
        source: 'github',
        kind: 'mr',
        project: this.project,
        mrIid: pr.number,
        sha: pr.head.sha,
        title: pr.title,
        description: pr.body ?? '',
        author: pr.user?.login ?? 'unknown',
        targetBranch: pr.base.ref,
        changedFiles: changes.changedFiles,
        diff: changes.diff,
        occurredAt: pr.updated_at,
      });
    }

    return events;
  }
}
