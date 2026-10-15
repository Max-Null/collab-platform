import type { Heartbeat } from './types.js';

/**
 * 平台**现在**的状态。
 *
 * 判据放在这里、不放前端：前端自己算的话，同一条「多久没动静算停摆」会在
 * 界面、MCP 出口、以后可能有的播报里各写一遍，迟早给出两个结论 ——
 * 理由与 `policy/health.ts` 一样，判据只该有一处。
 *
 * 连时间怎么念（「21 小时前」）也在这里拼好。前端再写一遍的话，
 * 两处的中文格式会开始分叉，而那是同一件事的第二种说法。
 *
 * 这个文件存在的起因很具体：一个控制台挂着 21 小时前的数据、界面齐全、
 * 没有任何地方说得出「它已经很久没动了」。而 `daemon.ts` 的注释里早就写着
 * 「一个跑着跑着悄悄死掉的守护进程，比没有守护进程更坏」——
 * 这一层就是让那句话变成看得见的东西。
 */

export type DaemonStatus = 'never' | 'alive' | 'late' | 'stopped';

export interface DaemonHealth {
  status: DaemonStatus;
  /** 距最后一次心跳多久（毫秒）；从来没跑过时为 undefined */
  sinceMs?: number;
  /** 心跳那句话 —— 前端直接显示，不自己拼 */
  note: string;
  /**
   * 「最后一条判断记录」那句人话。
   *
   * **它必须与心跳那句成对出现**，因为单看任何一个都答不出真正的问题：
   * 有心跳、没新记录 = 「在跑，只是最近没有可判的东西」（什么都不用做）；
   * 两个都旧 = 它停了（去把进程拉起来）。这两件事的处置完全相反。
   */
  lastJudgmentNote: string;
}

/**
 * 两个阈值都**相对预期间隔**取，不写死分钟数。
 *
 * 间隔是启动时给的（`--interval`）。拿一个固定的「超过 10 分钟就算挂」去套
 * 一个每小时的轮询，会天天误报；而误报多了，真停摆也没人信 ——
 * 与「图形比数字更有说服力，所以画错更危险」是同一类代价。
 *
 * · **宽限 2.5 倍**：一轮跑得比预期久（模型慢、GitLab 慢）是正常的，
 *   不该被读成停摆。
 * · **10 倍**：到这一步就不是「慢」，是没了。
 */
const LATE_FACTOR = 2.5;
const STOPPED_FACTOR = 10;

/**
 * 判一次「现在还在不在跑」。
 *
 * 三态而不是两态：**「没跑过」与「跑过但停了」的处置完全不同** ——
 * 前者是还没部署，后者是挂了。合并成一个「不在跑」，人就不知道该去做什么。
 */
export function judgeDaemon(input: {
  last?: Heartbeat;
  lastJudgmentAt?: string;
  now?: Date;
}): DaemonHealth {
  const now = input.now ?? new Date();

  const judgedAt = input.lastJudgmentAt ? Date.parse(input.lastJudgmentAt) : NaN;
  const lastJudgmentNote = Number.isFinite(judgedAt)
    ? `最后一条判断记录在 ${humanDuration(Math.max(0, now.getTime() - judgedAt))}前`
    : '一条判断记录都没有';

  if (!input.last) {
    return {
      status: 'never',
      lastJudgmentNote,
      // 措辞要留余地：库里没有心跳，**不等于**「平台从来没跑过」——
      // 心跳是后来才加的这一层，在那之前跑过的那些库，记录在、心跳不在。
      // 说成「从没跑过」会让人以为自己看错了（明明有判断记录）。
      note: '这个库里没有任何心跳记录 —— 常驻要么没在这份数据上跑过，要么跑在心跳落库之前',
    };
  }

  const last = input.last;
  const sinceMs = Math.max(0, now.getTime() - Date.parse(last.at));
  const interval = Math.max(1, last.intervalMs);
  const ago = humanDuration(sinceMs);
  const every = humanDuration(interval);

  const status: DaemonStatus =
    sinceMs > interval * STOPPED_FACTOR
      ? 'stopped'
      : sinceMs > interval * LATE_FACTOR
        ? 'late'
        : 'alive';

  let note: string;
  if (status === 'stopped') {
    note = `最后一轮心跳是 ${ago}前 —— 按每 ${every}一轮算，它已经不在了`;
  } else if (status === 'late') {
    note = `最后一轮是 ${ago}前 —— 比每 ${every}一轮迟了，可能卡在某一轮里`;
  } else if (!last.ok) {
    note = `在跑，但上一轮失败了（${ago}前）：${last.error ?? '没给出原因'}`;
  } else {
    note = `在跑，最后一轮 ${ago}前（拉到 ${last.events} 个事件，新判 ${last.judged} 条）`;
  }

  return { status, sinceMs, note, lastJudgmentNote };
}

/**
 * 一段人话的时间长度。
 *
 * 刻意**粗**：这一层要回答的是「多久没动静了」，不是「几点几分几秒」。
 * 精确到秒的数字会让人以为它有那个精度，而它没有 —— 那是一种假的可信。
 */
export function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} 小时`;
  return `${Math.round(h / 24)} 天`;
}

/** 格带上的一格 */
export interface BeatSlot {
  /** 这一片的起点 */
  at: string;
  /**
   * 这一片有多宽（毫秒）。
   *
   * 必须带出来：片宽是「跨度 ÷ 格数」算出来的，**它随跨度伸缩** ——
   * 读者若默认它是固定的（比如以为一格就是一轮），看到的历史长短就全错了。
   */
  spanMs: number;
  /** 这一片里有没有心跳。**没有 ≠ 跑了但没事**，两者在格带上必须是不同的东西 */
  present: boolean;
  /** 有心跳时：这几轮是不是都成了 */
  ok?: boolean;
  /** 有心跳时：悬停显示的那句话 */
  note?: string;
}

/**
 * 把心跳铺成**等距的时间片** —— 格带的每一格是一片时间，不是一条记录。
 *
 * **为什么必须是时间片。** 轮与轮之间的间隔能相差几个数量级：手工跑一次、
 * 常驻每 5 分钟一轮、或者停了 21 小时。按「一格一轮」等距铺，会把「隔了三小时的
 * 两轮」画成「紧挨着的下一轮」—— 而**那段空白恰恰是最该被看见的东西**。
 * 这就是 Grafana 那两个 issue（缺口在色带图里被画错）的教训。
 *
 * 片宽由跨度除以格数得来，所以它随跨度伸缩；调用方要把「一格约等于多久」说出来，
 * 否则读者会默认它是固定的（那样看到的历史长短就全错了）。
 */
export function toBeatSlots(
  beats: Heartbeat[],
  opts: { now: Date; slots?: number },
): BeatSlot[] {
  const slots = Math.max(1, opts.slots ?? 48);
  const last = beats[beats.length - 1];
  const width = Math.max(1, last?.intervalMs ?? 300_000);
  const end = opts.now.getTime();

  // 窗口至少盖住 slots 轮；如果最后一次心跳已经跑出这个窗口（停了很久），
  // 就把整个跨度一起盖进来 —— 否则「停了 21 小时」会画成一整条空带，
  // 与「从没跑过」长得一模一样，而那两件事要做的事完全不同。
  const firstAt = beats.length > 0 ? Date.parse(beats[0]!.at) : end;
  const span = Math.max(slots * width, end - firstAt + width);
  const slotWidth = span / slots;

  const out: BeatSlot[] = [];
  for (let i = slots - 1; i >= 0; i -= 1) {
    const from = end - (i + 1) * slotWidth;
    const to = end - i * slotWidth;
    const hit = beats.filter((b) => {
      const t = Date.parse(b.at);
      return t >= from && t < to;
    });

    if (hit.length === 0) {
      out.push({ at: new Date(from).toISOString(), spanMs: slotWidth, present: false });
      continue;
    }

    // 一片里挤了好几轮时（跨度被拉长的情况），只要有一轮失败就算这一片没成 ——
    // 失败不该被同一片里的成功盖掉。
    const failed = hit.filter((b) => !b.ok);
    out.push({
      at: new Date(from).toISOString(),
      spanMs: slotWidth,
      present: true,
      ok: failed.length === 0,
      note:
        failed.length > 0
          ? `${hit.length} 轮里有 ${failed.length} 轮失败：${failed[0]?.error ?? '没给原因'}`
          : `${hit.length} 轮，都成了`,
    });
  }

  return out;
}
