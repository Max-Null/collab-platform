import { judgeDaemon, summarizeFailures } from './heartbeat.js';
import type { Heartbeat, JudgmentRecord, PolicyVersionStats, ProbeResult } from './types.js';

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
  /**
   * 这段时间（约定 7 天）的全部心跳，按时间正序。
   *
   * 为什么要在这里再传一份：`lastBeat` 只够判「现在跑没跑」，而**「这段时间出过事吗」
   * 要的是时间范围** —— 控制台的格带只铺最近 48 片（约 4 小时），再早的失败滑出窗口
   * 就没人看得见了，而库里是全的。省略时简报就不报这一节。
   */
  recentBeats?: Heartbeat[];
  /**
   * 常驻最近一轮探的那个地址通不通。
   *
   * 它回答的是**这套系统自己测不出自己的那一块**：控制台挂了，它报不出自己挂了；
   * 库坏了，读库的东西全哑。而常驻是另一个进程，它还在 —— 所以这件事得由它记、
   * 由**别的出口**说出去（这份简报、MCP）。图说不了这件事，因为图就在控制台上。
   */
  probe?: ProbeResult;
}

/** 一条记录的摘要行：编号 + 策略 + 那句话的前半截 */
function line(r: JudgmentRecord): string {
  const reason = (r.reason ?? '（没有给出说明）').replace(/\s+/g, ' ').slice(0, 90);
  return `- #${r.id} \`${r.policyId}\` · ${r.eventId}\n  ${reason}`;
}

/** 心跳时刻按**本地时间**写成「月-日 时:分」—— 库里的 at 是 UTC，直接摆出来会让人看错 */
function localStamp(iso: string | undefined): string {
  if (!iso) return '（时刻未知）';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '（时刻未知）';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

  // 「这段时间出过事」与它同理：平台健康是这份简报存在的第一理由，而
  // 「昨天连着 21 轮拉不到仓库」正属于这一类 —— 它当时没有告诉任何人。
  const failures = summarizeFailures(input.recentBeats ?? []);
  // 「另一个东西打不开」也要说 —— 而且它是**唯一**能说这件事的地方（图在控制台上，
  // 控制台挂了图也就没了）。它同样属于「平台健康」，所以参与同一条判断。
  const probeDown = input.probe && !input.probe.ok ? input.probe : undefined;
  const nothingToSay =
    input.errors.length === 0 &&
    input.pending.length === 0 &&
    !platformNeedsAttention &&
    !failures &&
    !probeDown;
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

  // —— 打不开：这套系统自己测不出自己的那一块 ——
  if (probeDown) {
    out.push(`## 打不开 · ${probeDown.url}`, '');
    out.push(`- 常驻最近一轮探它是**不通**的：\`${probeDown.error ?? '没给原因'}\``);
    out.push('');
    out.push(
      '> 这件事只有常驻能记下来：那个东西挂了，它自己报不出来。' +
        '所以别指望在图上看它 —— 图就在它上面。',
    );
    out.push('');
  }

  // —— 这段时间出过事 ——
  // 它排在待办之前：这些事发生时没人被告知，而格带只铺最近 4 小时，早滑出去了。
  if (failures) {
    out.push(`## 最近出过事 · 连续 ${failures.longestRun} 轮失败`, '');
    out.push(
      `- ${localStamp(failures.runFrom)} 到 ${localStamp(failures.runTo)}，连续 **${failures.longestRun} 轮**没能拉到仓库`,
    );
    out.push(`- 这段时间共 ${failures.total} 轮，失败 ${failures.failed} 轮`);
    if (failures.commonError) out.push(`- 最常见的原因：\`${failures.commonError}\``);
    out.push('');
    out.push(
      '> **不会因此漏判** —— 轮询每次拉最新的一批，网络恢复后同样的事件会被重新拉到。' +
        '漏的是「这件事没人告诉过你」。',
    );
    out.push('');
    out.push(
      '> 为什么不报孤立的失败：一轮失败多半是抖动（网络重连、对端重启），它自己会好；' +
        '**连续两轮就已经跨过一个完整的轮询间隔**了，那不是抖动。',
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
