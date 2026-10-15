import { judgeDaemon } from './heartbeat.js';
import type { Heartbeat, JudgmentRecord, PolicyVersionStats } from './types.js';

/**
 * 每日简报 —— 「今天该看什么」。
 *
 * 设计文档 §3.4 给它的纪律比别的都严，因为它是**唯一主动占用人的注意力**的东西：
 * - **没内容就不发** —— 不发「今日无异常」这种填充物
 * - **一天一条**，不因为攒了三天就发三条
 * - **只放要你决定的**，不放「供你参考的」
 * - **超过 N 条就折叠**：「还有 12 条，点开看」—— 列全等于没列
 *
 * 所以它的返回值是 `string | undefined`，而 **`undefined` 表示今天没什么要说的**。
 * 这个签名是有意的：一个总是返回文本的接口，迟早会有人往里塞一句「今日无异常」，
 * 而那正是这套机制失效的开始 —— 一旦它每天都响，它响的时候也没人会看了。
 */

/** 超过这个条数就折叠，只列最要紧的几条 */
export const FOLD_AT = 5;

export interface BriefingInput {
  now: Date;
  lastBeat?: Heartbeat;
  lastJudgmentAt?: string;
  /** 还没被表过态的命中 */
  pending: JudgmentRecord[];
  /** 判断没做成、也没被回应的 —— 比命中更需要人看见 */
  errors: JudgmentRecord[];
  stats: PolicyVersionStats[];
  /** 过去 24 小时新落的判定条数 */
  last24h: number;
}

/** 一条记录的摘要行：编号 + 策略 + 那句话的前半截 */
function line(r: JudgmentRecord): string {
  const reason = (r.reason ?? '（没有给出说明）').replace(/\s+/g, ' ').slice(0, 90);
  return `- #${r.id} \`${r.policyId}\` · ${r.eventId}\n  ${reason}`;
}

function fold(rows: JudgmentRecord[]): string {
  const shown = rows.slice(0, FOLD_AT).map(line).join('\n');
  const rest = rows.length - FOLD_AT;
  return rest > 0 ? `${shown}\n- **还有 ${rest} 条** —— 控制台的代办页里能看全` : shown;
}

export function renderBriefing(input: BriefingInput): string | undefined {
  const daemon = judgeDaemon({
    last: input.lastBeat,
    lastJudgmentAt: input.lastJudgmentAt,
    now: input.now,
  });

  // 「平台没在跑」本身就是一件要人决定的事 —— 它是这个简报存在的第一理由。
  const platformNeedsAttention = daemon.status === 'stopped' || daemon.status === 'never';
  const nothingToSay = input.errors.length === 0 && input.pending.length === 0 && !platformNeedsAttention;
  if (nothingToSay) return undefined;

  const day = input.now.toISOString().slice(0, 10);
  const out: string[] = [`# 协作平台 · 简报 ${day}`, ''];

  // —— 平台状态：它排在待办之前，因为「平台没在跑」会让下面所有数字失效 ——
  out.push(`**平台**：${daemon.note}`);
  out.push(`　${daemon.lastJudgmentNote} · 过去 24 小时新判 ${input.last24h} 条`);
  out.push('');

  if (platformNeedsAttention) {
    out.push(
      daemon.status === 'never'
        ? '⚠️ 这个库里没有任何心跳记录 —— 常驻要么没在这份数据上跑过，要么跑在心跳落库之前。下面看到的都是手工跑或更早留下的。'
        : '⚠️ 常驻已经停了 —— 在它被拉起来之前，没有任何东西在看着仓库。',
    );
    out.push('');
  }

  // —— 要你决定的：判断没做成排前面 ——
  if (input.errors.length > 0) {
    out.push(`## 判断没做成 · ${input.errors.length} 条`, '');
    out.push('这些不是「没问题」，是**这一路判断没有真的发生**（取不到数、模型调不通）。');
    out.push('');
    out.push(fold(input.errors));
    out.push('');
  }

  if (input.pending.length > 0) {
    out.push(`## 等你表态 · ${input.pending.length} 条`, '');
    out.push('回写反应是观察期唯一的输入 —— 不回写，这条策略的升级阈值永远算不出来。');
    out.push('');
    out.push(fold(input.pending));
    out.push('');
  }

  // —— 观察期数字：只报数，不给建议（GM 报数据，不要权限）——
  if (input.stats.length > 0) {
    out.push('## 观察期', '');
    out.push('| 策略 / 版本 | 评估 | 看过 | 命中 | 没做成 | 否定 |');
    out.push('|---|---|---|---|---|---|');
    for (const s of input.stats) {
      out.push(
        `| \`${s.policyId}\` @ ${s.policyVersion} | ${s.total} | ${s.reviewed} | ${s.hit} | ${s.error} | ${s.rejected} |`,
      );
    }
    out.push('');
    out.push('> 「看过」是升级判据该用的分母 —— 用「评估」当分母等于用冷漠稀释信号。');
  }

  return out.join('\n').trimEnd() + '\n';
}
