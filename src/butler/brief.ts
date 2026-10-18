import type { LlmClient } from '../llm/client.js';
import type { RecordStore } from '../record/store.js';
import type { ModelUsage } from '../types.js';
import { buildFacts, renderFacts } from './facts.js';
import type { Facts } from './facts.js';

/**
 * 简报 —— 她主动开口的那一次。
 *
 * **日报与周报的纪律不一样，这是刻意的：**
 *
 * - **日报**：没内容就不发（沿用 `briefing.ts` 那条纪律）。一份每天都响的日报，
 *   响到第十天就没人看了 —— 而它响的时候本来该是有事的时候。
 * - **周报 / 月报**：**总是发**。它不是告警，是一份总结；一个没有异常的周
 *   仍然是「这周很安静」这个信息本身。用「没内容就不发」对待周报，
 *   等于让人连「这周没事」都不知道。
 *
 * 与旧`briefing.ts` 的差别不止在语言：那版把事实**直接拼成句子**
 * （「评估 9 · 看过 1 · 命中 2」），读的人得先听懂这些词才拿到信息。
 * 这一版把事实交给模型组织 —— **事实仍然来自同一份白名单**，变的只是说法。
 */

export type Period = 'day' | 'week' | 'month';

const PERIOD_SPEC: Record<Period, { hours: number; label: string; name: string }> = {
  day: { hours: 24, label: '最近 24 小时', name: '日报' },
  week: { hours: 168, label: '本周', name: '周报' },
  month: { hours: 720, label: '本月', name: '月报' },
};

export interface BriefOptions {
  store: RecordStore;
  llm: LlmClient;
  llmConfigured: boolean;
  period?: Period;
  now?: Date;
}

export interface BriefResult {
  ok: boolean;
  /** `undefined` 表示这次没什么要说的 —— 与「说了一句空话」是两件事 */
  text?: string;
  error?: string;
  facts: Facts;
  usage?: ModelUsage;
  /** 这次是不是被「没内容就不发」挡掉了 */
  suppressed?: boolean;
}

const DAY_SYSTEM = `你是一个团队的管家，早晨跟负责人说一句昨天的情况。

**只用记录里的事实。** 没数据就说没数据，不推测、不编。

**说人话**：不要出现策略名、版本号、观察期、分母这些词。
「改的内容和说的对不对得上」「有没有碰敏感文件」这种说法可以。

**短。** 三到五句。先给一句总览，再点出一两件值得看的，最后给一句你打算怎么做（如果有）。

**如果平台这段时间没在跑，或者判断没做成，第一句就说这个** —— 在那之前，
所有「没看出问题」都不成立。这比任何统计都重要。

没事的时候不要硬凑 —— 但如果真的一句话都没什么可说，系统就不会调你。`;

const REPORT_SYSTEM = `你是一个团队的管家，在给负责人交一份阶段总结。

你的活儿**不是复述数字**，是从这些记录里找出一个负责人应该知道、
但不会主动去查的事。比如：

- 谁在做事、谁这段时间没动过
- 哪个仓库很安静（安静可能是好事，也可能那条线停了）
- 有没有一项检查从来没被人核对过 —— 那意味着它一直在自说自话
- 平台自己有没有一段时间没在跑 —— 那段时间的「没看出问题」全都不成立
- 几次可疑的改动，是不是都指向同一类东西

**只用记录里的事实。** 没数据的地方直接说没数据，不推测动机、不评价代码好坏。

**说人话**：不出现策略名、版本号、观察期、分母这些词。不用小标题、不用表格。

**短。** 不超过八句。先给这一段的总貌，再给两三条真正值得注意的，最后一句可以是「接下来我打算盯什么」。`;

/**
 * 出一份简报。
 *
 * 返回 `text: undefined` 表示**这次没什么要说的** —— 只有日报会这样。
 * 周报/月报总是给一段话，因为「这周很安静」本身就是要说的内容。
 */
export async function brief(opts: BriefOptions): Promise<BriefResult> {
  const period = opts.period ?? 'day';
  const spec = PERIOD_SPEC[period];
  const facts = buildFacts(opts.store, {
    hours: spec.hours,
    label: spec.label,
    now: opts.now,
    limit: period === 'day' ? 20 : 40,
  });

  // —— 日报的「没内容就不发」——
  // 判据与 briefing.ts 一致：只有「要人决定的」或「平台自己的事」才算内容。
  // 周报/月报不走这一条（见文件抬头）。
  if (period === 'day') {
    const nothingToSay =
      facts.counts.pending === 0 &&
      facts.counts.error === 0 &&
      facts.health.status === 'alive' &&
      !facts.health.failure;
    if (nothingToSay) {
      return { ok: true, suppressed: true, facts };
    }
  }

  if (!opts.llmConfigured) {
    return {
      ok: false,
      error:
        '没有配置模型，我没法把记录组织成一段话。原始材料在 facts 里 —— 但直接发出去的话，' +
        '那不是在读一份总结，是在读日志。',
      facts,
    };
  }

  const prompt = [`【记录 · ${spec.label}】`, renderFacts(facts)].join('\n');

  let text: string;
  let usage: ModelUsage | undefined;
  try {
    const res = await opts.llm.complete({
      system: period === 'day' ? DAY_SYSTEM : REPORT_SYSTEM,
      prompt,
    });
    text = res.text;
    usage = res.usage;
  } catch (err) {
    return {
      ok: false,
      error: `模型没调通，这次的${spec.name}没生成：${(err as Error).message}`,
      facts,
    };
  }

  const body = text.trim();
  if (!body) {
    return { ok: false, error: `模型返回了空内容，这次的${spec.name}没有生成`, facts, usage };
  }

  return { ok: true, text: body, facts, usage };
}
