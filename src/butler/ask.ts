import type { LlmClient } from '../llm/client.js';
import type { RecordStore } from '../record/store.js';
import type { ModelUsage } from '../types.js';
import { buildFacts, renderFacts } from './facts.js';
import type { Facts } from './facts.js';

/**
 * 问答 —— 把「人问的一句话」变成「基于记录的回答」。
 *
 * 这一层的存在理由，是整个平台最缺的那块：**它一直没有嘴**。
 * 此前所有出口（控制台、简报、MCP）说的都是平台自己的话 ——
 * 「`review-claim-mismatch` @ 0.1.0 → error」「评估 9 · 看过 1」。
 * 那些话是对的，但一个团队负责人读不懂，也读不出该做什么。
 *
 * 三条纪律，与判据那边是同一条判据换了个对象：
 *
 * ① **只用取到的事实**。事实包由 `facts.ts` 按白名单取，这里不做任何补充。
 *    模型看到什么就说什么，看不到的要说「我不知道」——**编出来的那句话没有出处，
 *    而它读起来跟真的一模一样**。
 *
 * ② **说人话**。策略名、结局三态、观察期，是给维护这个平台的人看的；
 *    对着一个团队负责人说话时，它们必须被翻译。翻译规则写死在下面的提示词里，
 *    而不是让模型自由发挥 —— 否则同一个概念两次问会得到两个叫法。
 *
 * ③ **每条结论带编号**。人可以追问「#12 是怎么回事」，而那条记录确实存在。
 *    不带编号的回答，事后无法核对，也就无法被推翻。
 */

export interface AskOptions {
  store: RecordStore;
  llm: LlmClient;
  /** 是否真的配了模型。没配时不假装能组织语言。 */
  llmConfigured: boolean;
  /** 覆盖「现在」，测试用 */
  now?: Date;
  /** 显式指定窗口（小时）。不给就按问题里的日期词判断 */
  hours?: number;
}

export interface AskResult {
  ok: boolean;
  /** 人话回答。ok 为 false 时没有它 —— 不给半句编的话 */
  answer?: string;
  /** 答不上来的原因（没配模型、模型调不通、模型返回空） */
  error?: string;
  /** 这次用到的材料 —— 调用方可以展示，人也可以自己核对 */
  facts: Facts;
  /** 这次调用花了多少 */
  usage?: ModelUsage;
}

/**
 * 从问题里的日期词挑窗口。
 *
 * ⚠️ 这是**日期词的映射**，不是对意图的猜测：「昨天」就是 24 小时，「上周」就是 7 天。
 * 猜不到就用默认值，并且把这个选择说出来（`label` 会出现在回答里），
 * 而不是假装人问的就是那个范围。
 */
export function inferWindow(question: string): { hours: number; label: string } {
  const q = question;

  if (/上上?周|上个?星期/.test(q)) return { hours: 168, label: '上周' };
  if (/本周|这周|这个?星期/.test(q)) return { hours: 168, label: '本周' };
  if (/前天/.test(q)) return { hours: 48, label: '前天到现在' };
  if (/昨天|昨日|隔夜|昨晚/.test(q)) return { hours: 24, label: '昨天' };
  if (/今天|今早|刚才|刚刚/.test(q)) return { hours: 12, label: '今天' };
  if (/最近|近期/.test(q)) return { hours: 72, label: '最近三天' };

  return { hours: 24, label: '最近 24 小时' };
}

const SYSTEM = `你是一个团队的管家。你对着一份真实记录说话 —— 记录在下面。

**只用记录里的事实回答。** 记录里没有的，直接说你不知道，并说清你需要什么才能答。
不推测动机、不评价代码写得好不好、不编数字、不编人名。

**说人话。** 下面这些是系统内部的叫法，必须翻译成人的说法：
- \`review-claim-mismatch\` → 「改的内容和说的对不对得上」这项检查
- \`review-sensitive-path\` → 「有没有碰敏感文件」这项检查
- 命中 → 「看着可疑」；未命中 → 「没看出问题」；判断没做成 → 「这次没看成」
- push → 「推送」；MR → 「合并请求」
- 策略、版本号、观察期、分母 —— 这些词不要出现在回答里

**每条具体结论后面带记录编号**，写成（#12）。人能追问，而那条记录确实存在。
不带编号的结论，事后无从核对。

**不要替人补他做过的事。** 每条判定下面都写了「人的表态」——写「还没有任何人表态」
就是没表态。不许说「人已经确认过」「应该已经处理了」这类话：那是一种最坏的编造，
因为它把「没人看」说成了「看过了没问题」，而那正是这个系统存在的理由。

**短。** 先给结论，再给一两句支撑。不用小标题、不用表格、不复述记录内容。默认三到五句。

如果问题问的是一段时间：先给一句总览（几次变更、几次可疑），再点出最值得注意的一两件。

**如果记录显示平台这段时间根本没在跑**，第一句就说这个 —— 在那之前，
所有「没看出问题」都不成立。这是最重要的一句话，比任何统计都重要。

如果记录里的东西不足以回答这个问题，说清缺什么，不要用通用的判断填空。`;

/**
 * 问一句话，得到一段回答。
 *
 * 没配模型时**不返回任何生成的文本**：那种情况下任何「回答」都是编的 ——
 * 它会把「没有模型」伪装成「我看过了」。调用方拿到的是 `ok: false` + 原因 + 原始事实，
 * 想展示原始记录可以自己展示。
 */
export async function ask(question: string, opts: AskOptions): Promise<AskResult> {
  const probe = inferWindow(question);
  const hours = opts.hours ?? probe.hours;
  const label = opts.hours ? `最近 ${opts.hours} 小时` : probe.label;

  const facts = buildFacts(opts.store, { hours, label, now: opts.now });

  if (!opts.llmConfigured) {
    return {
      ok: false,
      error:
        '没有配置模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），我没法把这些记录组织成一句话。' +
        '下面是我手里的原始材料 —— 它们是真的，但需要你自己读。',
      facts,
    };
  }

  const prompt = [
    `【问题】${question}`,
    '',
    '【记录】',
    renderFacts(facts),
  ].join('\n');

  let text: string;
  let usage: ModelUsage | undefined;
  try {
    const res = await opts.llm.complete({ system: SYSTEM, prompt });
    text = res.text;
    usage = res.usage;
  } catch (err) {
    return {
      ok: false,
      error: `模型没调通，这次没有回答：${(err as Error).message}`,
      facts,
    };
  }

  const answer = text.trim();
  if (!answer) {
    return {
      ok: false,
      // 空回答与「没问题」长得一样 —— 这条判据在这个出口也适用
      error: '模型返回了空内容，这次没有回答 —— 这不等于「没什么可说的」',
      facts,
      usage,
    };
  }

  return { ok: true, answer, facts, usage };
}
