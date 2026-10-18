import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitHubApi } from '../github/api.js';
import type { ActionResult, DisposalLevel } from '../types.js';
import { renderComment } from './commenter.js';
import type { ActionContext, ActionRunner } from './commenter.js';

export interface GitHubCommentConfig {
  api: GitHubApi;
  /** `owner/repo` */
  project: string;
  /**
   * 写开关。**默认关。**
   *
   * 关着的时候动作照跑，只是不发到 GitHub：正文落到本地文件并原样返回。
   * 这不是「测试模式」—— 它是「我们还没准备好让机器人在真仓库里说话」的
   * 诚实表达。干燥跑走的是与真发同一条代码路径，落盘的就是会发出去的那份文本。
   */
  write: boolean;
  /** dry-run 与留档的正文落地目录 */
  outDir: string;
}

/**
 * 评论动作（发到 GitHub 的 PR）。
 *
 * 与 `gitlab-comment.ts` 是同一个东西，差别只在协议：GitHub 的 PR 评论挂在
 * `issues/{n}/comments` 上（PR 在 GitHub 的模型里就是一种 issue）。
 * 正文渲染、目录落档、写开关语义全都一样 —— **两边不该有不同的行为**，
 * 否则「在 GitLab 上判断正常的动作，换到 GitHub 上多做了点什么」这类差异
 * 永远没人会发现。
 */
export class GitHubCommentAction implements ActionRunner {
  readonly name = 'comment';

  constructor(private readonly cfg: GitHubCommentConfig) {}

  async run(ctx: ActionContext, level: DisposalLevel): Promise<ActionResult> {
    const body = renderComment(ctx.event, ctx.verdicts, level);

    mkdirSync(this.cfg.outDir, { recursive: true });
    const file = join(this.cfg.outDir, `${ctx.event.id}.md`);
    writeFileSync(file, body, 'utf8');

    if (!this.cfg.write) {
      return {
        action: 'comment',
        ok: true,
        output: `[dry-run] 未发送到 GitHub · 正文见 ${file}\n\n${body}`,
      };
    }

    // 推送事件没有可评论的落点 —— PR 评论接口挂在 PR 号上。
    //
    // **明确拒绝，不硬造一个落点。** GitHub 有 commit comment 接口，看起来
    // 「也通知到了」，但那不是一回事：没人会去 commit 页面找审查意见，
    // 于是它等于没发，而记录里却写着「已评论」—— 又一处看起来成功、实际没发生的动作。
    const prNumber = ctx.event.mrIid;
    if (prNumber === undefined) {
      return {
        action: 'comment',
        ok: false,
        error:
          `事件 ${ctx.event.id} 没有 PR 编号（${ctx.event.kind} 形态）—— 没有可评论的地方。` +
          `正文已落到 ${file}，这条记录如实标为「动作没做成」`,
      };
    }

    try {
      const note = await this.cfg.api.createComment(this.cfg.project, prNumber, body);
      return {
        action: 'comment',
        ok: true,
        output: `已评论 PR #${prNumber}（comment ${note.id}）\n\n${body}`,
        // 记下这条评论的 id —— 它是回滚唯一的线索（见 types.ts 的 externalRef）
        externalRef: String(note.id),
      };
    } catch (err) {
      return {
        action: 'comment',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
