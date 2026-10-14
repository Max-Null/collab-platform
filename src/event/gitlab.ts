import type { GitLabApi } from '../gitlab/api.js';
import type { ChangeEvent } from '../types.js';
import type { EventSource } from './source.js';

/**
 * GitLab 轮询事件源。
 *
 * 为什么第一版是轮询而不是 webhook —— 三条独立的理由，不是「先做简单的」：
 * ① 轮询只要一个**只读** token，不需要 GitLab 管理员在仓库上配任何东西；
 * ② 它**不产生任何写操作**，在真仓库上试的第一阶段，这比实时性重要得多；
 * ③ webhook 需要平台有一个 GitLab 够得着的地址，那是部署问题不是代码问题 ——
 *    而且在它解决之前，整条链路会一直卡在「等运维」上。
 *
 * 轮询的固有代价是**漏掉开了又关的短命 MR**。第一版接受这个漏：
 * 那种 MR 本来也没人来得及审，而「所有 MR 都被看过」不是靠截获每一次事件
 * 达成的，是靠事件标识里带上 commit sha —— 同一个 MR 的新提交会重新变成新事件。
 */
export class GitLabPollSource implements EventSource {
  readonly name = 'gitlab';

  constructor(
    private readonly api: GitLabApi,
    private readonly project: string,
    private readonly opts: { limit?: number; state?: string } = {},
  ) {}

  async fetch(): Promise<ChangeEvent[]> {
    const mrs = await this.api.listMergeRequests(this.project, this.opts);
    const events: ChangeEvent[] = [];

    for (const mr of mrs) {
      const changes = await this.api.fetchChanges(this.project, mr.iid);

      events.push({
        // 事件 id 里带 sha：同一个 MR 改一版就是一次新事件，
        // 因此「这个版本被审过没有」有答案，而不是「这个 MR 被审过没有」
        id: `gitlab-${this.project.replace(/[^\w]+/g, '-')}-${mr.iid}-${mr.sha ?? 'nosha'}`,
        source: 'gitlab',
        project: this.project,
        mrIid: mr.iid,
        title: mr.title,
        description: mr.description ?? '',
        author: mr.author?.username ?? 'unknown',
        targetBranch: mr.target_branch,
        changedFiles: changes.changedFiles,
        diff: changes.diff,
        occurredAt: mr.updated_at,
      });
    }

    return events;
  }
}
