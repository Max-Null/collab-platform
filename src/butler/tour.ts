import type { LlmClient } from '../llm/client.js';
import type { RecordStore } from '../record/store.js';
import { buildFacts, renderFacts } from './facts.js';
import type { Facts } from './facts.js';

/**
 * 导览 —— 管家带着人走一遍，而不是坐在那儿等人提问。
 *
 * **这与 `ask.ts` 是两种东西，不是同一个东西的两种用法：**
 *
 * - 问答（`ask`）：人问什么，它答什么。人没问到的部分，他永远不知道。
 * - 导览（这里）：**它先看一遍，然后决定带人看哪几件、按什么顺序**。
 *   「先看哪件」本身就是内容 —— 一屏十次变更摊在那儿，人不知道从哪儿下手；
 *   而「① 这件最急，② 这件已经处理过但你该知道，③ 这件其实没问题」
 *   是一个判断，不是把数据换个排版。
 *
 * ⚠️ **返回的是结构化的停靠点，不是一段话。** 这是它能「指着展品讲」的前提：
 * 每一段解说都挂在一次具体的变更上（`eventId`），界面才能把它摆进对应的卡片里。
 * 如果只返回一段自由文本，控制台就只能在旁边再开一个聊天框 ——
 * 那又变回了「问题自己把两边对上」。
 *
 * ⚠️ **模型给的 eventId 必须来自给定的事实**。挂不上的解说一律丢弃并计数：
 * 编一个不存在的展品编号，人点进去会看到另一件事，而那种错误没人会发现。
 */

export interface TourStop {
  /** 挂在哪一次变更上 —— 界面靠它把解说摆进对应的卡片 */
  eventId: string;
  /** 为什么带你看这一件（一句话） */
  why: string;
  /** 这件事背后发生了什么（两三句） */
  say: string;
  /** 建议的观看次序，从 1 开始 */
  order: number;
}

export interface Tour {
  /** 开门第一句：今天整体怎么样，建议从哪儿开始 */
  intro: string;
  stops: TourStop[];
  /** 收尾一句（可省） */
  closing?: string;
}

export interface TourResult {
  ok: boolean;
  tour?: Tour;
  error?: string;
  facts: Facts;
  /** 模型给了、但挂不到任何变更上的解说条数 —— 有值就说明它在编展品 */
  droppedStops?: number;
}

const SYSTEM = `你是一个团队的管家，现在带着负责人逛一遍「这段时间发生了什么」。

你会看到一屏变更记录。你的活儿是**带路**，不是复述：

1. 挑出值得停留的几件（**最多 5 件**），按你建议看的顺序排列。
   挑选的优先级，从高到低：
   - **判断没做成**：那不是「有问题」，是「这次没看成」，而它不留痕迹 —— 必须排在最前。
   - **还没有任何人表态的**：人打开这一屏就是为了知道「什么在等我」。
     记录里每条判定下面都写了「人的表态」，写「还没有任何人表态」就是真的没人看过。
   - **被人否决过的**（说明判定不准，值得复盘）。
   - 其余值得知道的事。
   ⚠️ 只要上面有一类是存在的，就不能一件都不挑 —— stops 为空只允许出现在
     真的没有任何值得看的事情时。
2. 每一件说两句话：
   - why：为什么带他看这一件（一句话，要具体，不要「这条有问题」这种）
   - say：这件事背后发生了什么（两三句）。**不要复述标题**，标题他看得见；
     要讲标题背后的事——它实际改了什么、跟它说的差在哪、人有没有表态过。
3. intro：一句开场，说清整体和「从哪儿开始看」。
4. closing：一句收尾，可以省。

**只用记录里的事实。** 没写的就是没有：不许说「人已经确认过」——
每条判定下面都写了「人的表态」，写「还没有任何人表态」就是没人表态。
没数据的地方直说。

**说人话**：不出现策略名、版本号、观察期、分母这些词。
「改的内容和说的对不对得上」「有没有碰敏感文件」这种说法可以。

**eventId 必须从下面记录里原样抄**，一个字都不要改 —— 界面靠它把你说的话放到对应那一件旁边。
编一个 id，人点进去会看到另一件事。

只输出 JSON，不要别的话：
{"intro":"...","stops":[{"eventId":"...","why":"...","say":"..."}],"closing":"..."}`;

function parseTour(text: string): { intro: string; stops: Array<Omit<TourStop, 'order'>>; closing?: string } | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;

  const d = data as Record<string, unknown>;
  if (typeof d.intro !== 'string') return null;

  const rawStops = Array.isArray(d.stops) ? d.stops : [];
  const stops = rawStops
    .map((s) => {
      const o = s as Record<string, unknown>;
      if (typeof o.eventId !== 'string' || typeof o.say !== 'string') return null;
      return {
        eventId: o.eventId,
        why: typeof o.why === 'string' ? o.why : '',
        say: o.say,
      };
    })
    .filter((s): s is { eventId: string; why: string; say: string } => s !== null);

  return {
    intro: d.intro,
    stops,
    closing: typeof d.closing === 'string' && d.closing.trim() ? d.closing : undefined,
  };
}

/**
 * 生成一份导览。
 *
 * 没有配模型时**不返回导览**：一份由模板拼出来「导览」会看起来像是她想过了，
 * 而实际上没有人看过这些记录 —— 那正是这套东西要防的形态。
 * 调用方拿到 `ok: false` 与原始事实，界面就不显示导览区（而不是显示一段空话）。
 */
export async function tour(
  opts: { store: RecordStore; llm: LlmClient; llmConfigured: boolean; hours?: number; now?: Date },
): Promise<TourResult> {
  const hours = opts.hours ?? 24;
  const facts = buildFacts(opts.store, {
    hours,
    label: '最近这一批变更',
    // ⚠️ **不按时间切片**：界面上摆着哪些变更，导览就必须看哪些。
    // 两边口径一旦不同，就会出现「下面明明有一件『这次没看成』，导览却说没有」——
    // 那不是模型看漏了，是它拿到的根本不是同一份材料。
    // （实测就撞上了：界面按「最近 N 次」列，导览按「24 小时」取，1 天前那次被切掉了。）
    noWindow: true,
    now: opts.now,
  });

  // 一件都没有时不必调模型 —— 但也不能给一个「今天没问题」的空导览：
  // 「没有变更」与「平台没在看着」长得一样，这件事在 facts.blanks 里已经写着了，
  // 导览该做的是把它说出来，而不是沉默。这里给一句**事实性**的话，不冒充她的判断。
  if (facts.changes.length === 0) {
    return {
      ok: true,
      facts,
      tour: {
        intro:
          facts.health.status === 'alive'
            ? '这段时间没有变更进来。'
            : '这段时间没有变更进来 —— 但平台现在没在看着，所以「没有变更」和「没在看」分不开。',
        stops: [],
      },
    };
  }

  if (!opts.llmConfigured) {
    return {
      ok: false,
      error: '没有配置模型，所以我没法替你先看一遍。下面的记录是真的，但没人替你排过顺序。',
      facts,
    };
  }

  const prompt = [`【记录】`, renderFacts(facts, { showEventId: true })].join('\n');

  let text: string;
  try {
    const res = await opts.llm.complete({ system: SYSTEM, prompt, json: true });
    text = res.text;
  } catch (err) {
    return { ok: false, error: `模型没调通，这次没有导览：${(err as Error).message}`, facts };
  }

  const parsed = parseTour(text);
  if (!parsed) {
    return { ok: false, error: '模型返回的不是约定的 JSON，这次没有导览', facts };
  }

  // —— 把每一段挂到真实的变更上 ——
  // 挂不上的丢弃：编一个展品编号，人点进去会看到另一件事，而这种错误
  // 在界面上看起来完全正常（一段说得挺好的话，放在了错误的那张卡旁边）。
  const known = new Set(facts.changes.map((c) => c.eventId));
  const kept = parsed.stops.filter((s) => known.has(s.eventId));
  const dropped = parsed.stops.length - kept.length;

  return {
    ok: true,
    facts,
    droppedStops: dropped,
    tour: {
      intro: parsed.intro,
      closing: parsed.closing,
      stops: kept.map((s, i) => ({ ...s, order: i + 1 })),
    },
  };
}
