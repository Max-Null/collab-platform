import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ActionResult,
  ChangeEvent,
  DisposalLevel,
  PolicyVerdict,
} from '../types.js';

export interface ActionContext {
  event: ChangeEvent;
  /**
   * 这次命中的判定，可能来自多条策略。
   *
   * 一次事件**合成一条评论**：GM 在这里的作用是替人省 review 的精力，
   * 而按策略各刷一条评论，省下的精力会从另一头还回去。
   */
  verdicts: PolicyVerdict[];
}

export interface ActionRunner {
  readonly name: string;
  run(ctx: ActionContext, level: DisposalLevel): Promise<ActionResult>;
}

/**
 * 生成评论正文。
 *
 * **每次判定都说话，包括什么都没发现的时候。** 理由不是「礼貌」：
 * 如果只在命中时说话，那「MR 上没有评论」就同时意味着两件事 ——
 * 我看过且没问题，以及 GM 根本没跑（服务挂了、这条不在轮询范围、
 * 判据全落 error）。沉默承担不了「通过」这个含义，因为失败也长得一样。
 * 这是「评估失败不等于通过」在人的感知层的同一条判据。
 *
 * 格式上把「结论」和「依据」分开写 —— 判断记录里它们是两个字段，
 * 呈现给人的时候也该分得开。结论句直接取 `verdict.reason`，动作层不自己
 * 编话：动作层一旦开始替策略总结，同一个判断在平台上和评论里就会有两种
 * 说法，而留痕对不上话就白留了。
 */
export function renderComment(
  event: ChangeEvent,
  verdicts: PolicyVerdict[],
  level: DisposalLevel,
): string {
  const levelNote =
    level === 1 ? '只提示，不阻塞' : level === 2 ? '已留痕，会跟进' : '需人工确认后才继续';

  const hits = verdicts.filter((v) => v.outcome === 'hit');
  const errors = verdicts.filter((v) => v.outcome === 'error');

  const lines: string[] = [];

  lines.push('**【协作平台 · GM 提醒】**');
  lines.push('');
  lines.push(`MR !${event.mrIid}（作者 @${event.author}）`);

  if (hits.length > 0) {
    lines.push('');
    lines.push(`这次变更有 ${hits.length} 处需要确认：`);
    hits.forEach((verdict, i) => {
      lines.push('');
      lines.push(`**${i + 1}. ${verdict.reason ?? '需要确认'}**`);
      lines.push('');
      // 前提写在结论下面、依据上面 —— 它是结论的一部分，不是依据。
      // 丢掉它，人看到的就是一条无条件的结论。
      if (verdict.precondition) {
        lines.push(`> ⚠️ 成立前提：${verdict.precondition}`);
        lines.push('');
      }
      for (const e of verdict.evidence) {
        lines.push(`- \`${e.kind}\` ${e.detail}${e.ref ? `（出处：\`${e.ref}\`）` : ''}`);
      }
    });
  } else if (errors.length > 0) {
    lines.push('');
    lines.push(
      `这次**没有做成判断**：${errors.map((v) => `\`${v.policyId}\``).join(' · ')} ` +
        '没能拿到判断所需的输入。',
    );
    lines.push('');
    lines.push('**这不等于通过。**');
    lines.push('');
    for (const v of errors) {
      lines.push(`- \`${v.policyId}\`：${v.reason ?? '（没有给出说明）'}`);
    }
  } else {
    lines.push('');
    lines.push('这次变更**没有发现问题**。');
    lines.push('');
    lines.push(
      '（这是「看过并且没看出问题」，不是「没人看」—— 判断没做成的那些会在上面明说。）',
    );
  }

  lines.push('');
  lines.push(
    `> 本次判定：${verdicts
      .map((v) => `\`${v.policyId}\` @ ${v.policyVersion} → ${v.outcome}`)
      .join(' · ')}` + ` · 处置级别 ${level}（${levelNote}）`,
  );

  return lines.join('\n');
}

/**
 * 评论动作。
 *
 * 第一版不真的调用 GitLab API，而是把评论正文落到 var/comments/ 并打印 ——
 * 这样能在不产生垃圾数据的前提下验证「动作」这一段接得上，
 * 也留了可回看的产物供测试断言。
 */
export class CommentAction implements ActionRunner {
  readonly name = 'comment';

  constructor(private readonly outDir: string) {}

  async run(ctx: ActionContext, level: DisposalLevel): Promise<ActionResult> {
    try {
      const body = renderComment(ctx.event, ctx.verdicts, level);
      mkdirSync(this.outDir, { recursive: true });
      const file = join(this.outDir, `${ctx.event.id}.md`);
      writeFileSync(file, body, 'utf8');

      return {
        action: 'comment',
        ok: true,
        output: body,
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
