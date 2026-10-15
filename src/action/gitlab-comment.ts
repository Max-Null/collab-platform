import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GitLabApi } from '../gitlab/api.js';
import type { ActionResult, DisposalLevel } from '../types.js';
import { renderComment } from './commenter.js';
import type { ActionContext, ActionRunner } from './commenter.js';

export interface GitLabCommentConfig {
  api: GitLabApi;
  project: string;
  /**
   * 写开关。**默认关。**
   *
   * 关着的时候动作照跑，只是不发到 GitLab：正文落到本地文件并原样返回。
   * 这不是「测试模式」—— 它是「我们还没准备好让机器人在真仓库里说话」的
   * 诚实表达。关掉写，动作这一段仍然被完整验证过，只有最后一跳没跳，
   * 而最后一跳恰恰是唯一会留下垃圾数据的一跳。
   */
  write: boolean;
  /** dry-run 与留档的正文落地目录 */
  outDir: string;
}

/**
 * 评论动作（发到 GitLab）。
 *
 * 与本地那个 CommentAction 的差别只有最后一跳：正文渲染、目录落档都一样，
 * 所以「关掉写」验证到的东西也就是「打开写」时真正会发出去的那份文本 ——
 * 这正是干燥跑必须跑在真实代码路径上、而不是另写一段 demo 的原因。
 */
export class GitLabCommentAction implements ActionRunner {
  readonly name = 'comment';

  constructor(private readonly cfg: GitLabCommentConfig) {}

  async run(ctx: ActionContext, level: DisposalLevel): Promise<ActionResult> {
    const body = renderComment(ctx.event, ctx.verdicts, level);

    mkdirSync(this.cfg.outDir, { recursive: true });
    const file = join(this.cfg.outDir, `${ctx.event.id}.md`);
    writeFileSync(file, body, 'utf8');

    if (!this.cfg.write) {
      return {
        action: 'comment',
        ok: true,
        output: `[dry-run] 未发送到 GitLab · 正文见 ${file}\n\n${body}`,
      };
    }

    // 推送事件没有可评论的落点 —— GitLab 的评论接口挂在 MR 上。
    //
    // **明确拒绝，不硬造一个落点。** 发到 commit 评论上看起来「也通知到了」，
    // 但那是另一种东西：没人会去 commit 页面找审查意见，于是它等于没发，
    // 而记录里却写着「已评论」——又一处看起来成功、实际没发生的动作。
    const mrIid = ctx.event.mrIid;
    if (mrIid === undefined) {
      return {
        action: 'comment',
        ok: false,
        error:
          `事件 ${ctx.event.id} 没有 MR 编号（${ctx.event.kind} 形态）—— 没有可评论的地方。` +
          `正文已落到 ${file}，这条记录如实标为「动作没做成」`,
      };
    }

    try {
      const note = await this.cfg.api.createNote(this.cfg.project, mrIid, body);
      return {
        action: 'comment',
        ok: true,
        output: `已评论 MR !${mrIid}（note ${note.id}）\n\n${body}`,
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
