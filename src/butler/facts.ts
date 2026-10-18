import { judgeDaemon, summarizeFailures } from '../heartbeat.js';
import type { RecordStore } from '../record/store.js';
import type { VerdictOutcome } from '../types.js';

/**
 * 事实层 —— 管家引用的全部材料。
 *
 * **这一层只说事实，不说人话。** 语言由 `ask.ts` / `brief.ts` 里的模型来组织。
 * 分开的理由跟判据那边是同一条：**取数要能被审，说话可以随场景变**。
 * 混在一起，模型就同时决定了「看什么」和「怎么说」，而它说的每句话都无从核对了。
 *
 * 白名单在这里也成立：**能取什么写死在这个文件里**，不是「库里有什么就给什么」。
 * 一份塞满整库的上下文，模型会从里面挑它顺眼的，而挑的过程没人看得见。
 */

export interface FactsWindow {
  from: string;
  to: string;
  /** 给人看的说法：「最近 24 小时」「上周」 */
  label: string;
}

export interface JudgmentFact {
  id: number;
  policy: string;
  version: string;
  outcome: VerdictOutcome;
  reason?: string;
  precondition?: string;
  /** 命中时的具体依据（命中了哪些文件、模型说了哪几条） */
  items: string[];
  reaction?: string;
  reactionNote?: string;
}

export interface ChangeFact {
  eventId: string;
  project?: string;
  author?: string;
  title?: string;
  kind?: 'mr' | 'push';
  at: string;
  verdict: VerdictOutcome;
  pending: number;
  files?: string[];
  judgments: JudgmentFact[];
}

export interface AuthorFact {
  author: string;
  changes: number;
  hit: number;
  error: number;
}

export interface Facts {
  window: FactsWindow;
  /** 平台自己活没活着 —— 它排第一，因为它不成立，下面所有数字都失效 */
  health: {
    status: string;
    note: string;
    lastJudgmentNote?: string;
    /** 这段时间里连续失败的段（没出过事就是 null） */
    failure?: { longestRun: number; total: number; failed: number; commonError?: string } | null;
  };
  counts: {
    changes: number;
    hit: number;
    miss: number;
    error: number;
    pending: number;
  };
  changes: ChangeFact[];
  byProject: Array<{
    project: string;
    changes: number;
    hit: number;
    error: number;
    miss: number;
    pending: number;
    lastAt?: string;
  }>;
  byAuthor: AuthorFact[];
  policies: Array<{
    policyId: string;
    policyVersion: string;
    total: number;
    reviewed: number;
    hit: number;
    error: number;
    rejected: number;
    /** 健康判定给的一句话（样本够不够、有没有异常） */
    healthNote?: string;
  }>;
  /**
   * 她**答不上来**的地方 —— 如实交给调用方，让它说「这个我不知道」。
   *
   * 这不是错误处理，是内容：一个管家最要紧的品性是不编。
   * 库里没有「这个 MR 为什么被合了」「谁应该负责」这类东西，
   * 而它们恰恰是人最可能问的。
   */
  blanks: string[];
}

export interface FactsOptions {
  /** 窗口：往前多少小时。默认 24 */
  hours?: number;
  /** 最多带几次变更（按时间倒序）。默认 20 */
  limit?: number;
  /**
   * **不按时间过滤，只看「最近这一批变更」**。
   *
   * 导览（`tour.ts`）用它：界面上摆着哪些变更，导览就必须看哪些。
   * 两边的切片一旦不一致，就会出现「界面上有一件待处理的，而导览说没有」——
   * 那不是模型看漏了，是它看的根本不是同一份材料，而人只会认为它在胡说。
   */
  noWindow?: boolean;
  /** 覆盖「现在」，测试用 */
  now?: Date;
  /** 窗口的说法，例如「昨天」「上周」 */
  label?: string;
}

/** 从依据里挑出能直接引用的话 —— 只要 rule 与 changed_file 两类 */
function evidenceItems(evidenceJson: string): string[] {
  try {
    const arr: unknown = JSON.parse(evidenceJson);
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    for (const e of arr) {
      const ev = e as { kind?: unknown; detail?: unknown };
      if (!ev || typeof ev !== 'object') continue;
      if ((ev.kind === 'rule' || ev.kind === 'changed_file') && typeof ev.detail === 'string') {
        out.push(ev.detail);
      }
    }
    return out;
  } catch {
    // 坏数据当成「没有细节」——与 store 里那几个解析函数同一个理由：
    // 一条坏记录不该让整个回答无法生成。但它会被记进 blanks，不静默吞掉。
    return [];
  }
}

/**
 * 时间 → 人读的样子。
 *
 * ⚠️ **库里的时刻是 UTC，直接摆给模型看，它会把时区算错。** 这不是假设：
 * 第一版给的就是 `2026-10-18T07:42:51.280Z`，它回了一句「今天 09:06」——
 * 真正的时间是 15:42。而一个把时刻说错的管家，说的每件事都要被重新核对。
 *
 * 所以这里给的是**本地时刻 + 相对时间**两份：前者能直接说出口，
 * 后者能判断「这是刚刚还是很久以前」。两份都不需要模型再做换算。
 */
function humanTime(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '（时刻未知）';

  const p = (n: number): string => String(n).padStart(2, '0');
  const local = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000);
  let rel: string;
  if (mins < 1) rel = '刚刚';
  else if (mins < 60) rel = `${mins} 分钟前`;
  else if (mins < 1440) rel = `${Math.floor(mins / 60)} 小时前`;
  else rel = `${Math.floor(mins / 1440)} 天前`;

  return `${local}（${rel}）`;
}

/**
 * 取一层事实。
 *
 * `blanks` 不是可选装饰：**它记录的是「人可能问、但库里没有」的类别**，
 * 由下一个人（模型）决定怎么诚实地说出来。
 */
export function buildFacts(store: RecordStore, opts: FactsOptions = {}): Facts {
  const now = opts.now ?? new Date();
  const hours = opts.hours ?? 24;
  const limit = opts.limit ?? 20;

  const from = new Date(now.getTime() - hours * 3600_000);
  const fromIso = from.toISOString();
  const toIso = now.toISOString();

  // 多取一些再按窗口过滤：listChanges 是按事件排的，而窗口可能把它们切在中途
  const all = store.listChanges(300);
  const inWindow = opts.noWindow ? all : all.filter((c) => c.lastSeenAt >= fromIso);
  const picked = inWindow.slice(0, limit);

  const changes: ChangeFact[] = picked.map((c) => ({
    eventId: c.eventId,
    project: c.project,
    author: c.author,
    title: c.title,
    kind: c.eventKind,
    at: c.lastSeenAt,
    verdict: c.verdict,
    pending: c.pending,
    files: c.changedFiles,
    judgments: c.judgments.map((j) => ({
      id: j.id,
      policy: j.policyId,
      version: j.policyVersion,
      outcome: j.outcome,
      reason: j.reason,
      precondition: j.precondition,
      items: evidenceItems(j.evidenceJson),
      reaction: j.reaction,
      reactionNote: j.reactionNote,
    })),
  }));

  // —— 按项目：以窗口内的变更重算，不用全量 ——
  // 用全量会给出一句「累计 40 次」，而问题问的是「昨天」，那个数字会把人带偏。
  const projMap = new Map<string, Facts['byProject'][number]>();
  for (const c of inWindow) {
    const key = c.project ?? '';
    let p = projMap.get(key);
    if (!p) {
      p = { project: key, changes: 0, hit: 0, error: 0, miss: 0, pending: 0 };
      projMap.set(key, p);
    }
    p.changes += 1;
    p.pending += c.pending;
    if (c.verdict === 'hit') p.hit += 1;
    else if (c.verdict === 'error') p.error += 1;
    else p.miss += 1;
    if (!p.lastAt || c.lastSeenAt > p.lastAt) p.lastAt = c.lastSeenAt;
  }
  const byProject = [...projMap.values()].sort((a, b) =>
    (b.lastAt ?? '').localeCompare(a.lastAt ?? ''),
  );

  // —— 按人：同一次变更上几条策略不重复计数 ——
  const authorMap = new Map<string, AuthorFact>();
  for (const c of inWindow) {
    const key = c.author ?? '';
    let a = authorMap.get(key);
    if (!a) {
      a = { author: key, changes: 0, hit: 0, error: 0 };
      authorMap.set(key, a);
    }
    a.changes += 1;
    if (c.verdict === 'hit') a.hit += 1;
    else if (c.verdict === 'error') a.error += 1;
  }
  const byAuthor = [...authorMap.values()].sort((a, b) => b.changes - a.changes);

  // —— 平台状态 ——
  const lastBeat = store.lastHeartbeat();
  const lastJudgmentAt = store.lastJudgmentAt();
  const daemon = judgeDaemon({ last: lastBeat, lastJudgmentAt, now });
  const failure = summarizeFailures(store.heartbeatsSince(fromIso));

  const counts = {
    changes: inWindow.length,
    hit: inWindow.filter((c) => c.verdict === 'hit').length,
    miss: inWindow.filter((c) => c.verdict === 'miss').length,
    error: inWindow.filter((c) => c.verdict === 'error').length,
    pending: inWindow.reduce((n, c) => n + c.pending, 0),
  };

  const policies = store.statsByPolicyVersion().map((s) => ({
    policyId: s.policyId,
    policyVersion: s.policyVersion,
    total: s.total,
    reviewed: s.reviewed,
    hit: s.hit,
    error: s.error,
    rejected: s.rejected,
  }));

  // —— 她答不上来的那些 ——
  // 写死而不是让模型去发现：这些是**这个系统结构上就没有**的信息，
  // 而它们恰恰是人最可能问的。模型不知道这件事，就会用合理的措辞编一个。
  const blanks: string[] = [
    '变更背后的意图（为什么这么改、是不是有意的）——记录里只有「改了什么」和「策略怎么判的」',
    '任务、需求、排期与里程碑——平台没有这些数据源',
    '谁应该为一次变更负责、谁该被催——记录里只有提交者，没有职责划分',
    '代码质量本身的判断（比如实现好不好）——策略只判「改动与声称是否相符」和「有没有碰敏感路径」',
    'GitLab 上变更之后的进展（是否被合并、被谁合并、后来又改了几次）——平台只读轮询，不追踪',
  ];

  if (policies.length === 0) blanks.push('任何策略的出现记录——库里还没有判定被落过');
  if (counts.changes === 0) {
    blanks.push(
      `这个窗口（${opts.label ?? `最近 ${hours} 小时`}）里的变更——它可能意味着「没有变更」，` +
        '也可能意味着「平台没在看着」，这两种情况从库里分不出来',
    );
  }

  return {
    window: { from: fromIso, to: toIso, label: opts.label ?? `最近 ${hours} 小时` },
    health: {
      status: daemon.status,
      note: daemon.note,
      lastJudgmentNote: daemon.lastJudgmentNote,
      failure: failure
        ? {
            longestRun: failure.longestRun,
            total: failure.total,
            failed: failure.failed,
            commonError: failure.commonError,
          }
        : null,
    },
    counts,
    changes,
    byProject,
    byAuthor,
    policies,
    blanks,
  };
}

/**
 * 把事实渲染成给模型读的正文。它读的是表格，不是靠猜结构。
 *
 * `showEventId`：只有在**要模型把这些材料挂回具体某一条**的时候才开
 * （导览 `tour.ts` 用）。问答不需要它 —— 回答里引用事件 id 对人没有意义，
 * 人会拿 `#编号` 去追判断记录。
 *
 * ⚠️ 不开这个开关又不能不给：第一版导览就是这么坏的 —— 提示词里写着
 * 「eventId 必须原样抄」，而材料里**根本没有 eventId**，于是模型只能编。
 * 编出来的 id 挂不上任何一条，全部被丢弃，界面上就是「她说有两件值得看」
 * 加一个空清单。**要求一样东西之前，先确认给到了。**
 */
export function renderFacts(f: Facts, opts: { showEventId?: boolean } = {}): string {
  const out: string[] = [];
  // 相对时间以窗口终点为基准 —— 与「现在」差几分钟，不该由模型自己推
  const now = new Date(f.window.to);

  out.push(`## 时间窗`);
  out.push(`${f.window.label}（${humanTime(f.window.from, now)} 到 ${humanTime(f.window.to, now)}）`);
  out.push('');

  out.push(`## 平台状态`);
  out.push(`${f.health.note}`);
  if (f.health.lastJudgmentNote) out.push(f.health.lastJudgmentNote);
  if (f.health.failure) {
    out.push(
      `⚠️ 这段时间有过连续 ${f.health.failure.longestRun} 轮失败（共 ${f.health.failure.total} 轮、失败 ${f.health.failure.failed} 轮）` +
        (f.health.failure.commonError ? `，最常见原因：${f.health.failure.commonError}` : ''),
    );
  }
  out.push('');

  out.push(`## 这段时间的变更（${f.counts.changes} 次：命中 ${f.counts.hit} · 没做成 ${f.counts.error} · 没问题 ${f.counts.miss} · 待你表态 ${f.counts.pending}）`);
  out.push('');

  if (f.changes.length === 0) {
    out.push('（这个窗口里没有变更）');
  } else {
    for (const c of f.changes) {
      const who = c.author || '未知作者';
      const where = c.project || '项目未记录';
      out.push(`### [${who}] ${c.title ?? c.eventId}`);
      out.push(`- 项目：${where} · 形态：${c.kind === 'mr' ? 'MR' : 'push'} · 时间：${humanTime(c.at, now)}`);
      if (opts.showEventId) out.push(`- eventId（原样引用，不要改一个字）：${c.eventId}`);
      if (c.files && c.files.length) out.push(`- 改了：${c.files.slice(0, 8).join('、')}`);
      for (const j of c.judgments) {
        const outcome =
          j.outcome === 'hit' ? '命中' : j.outcome === 'error' ? '判断没做成' : '未命中';
        out.push(`- 判定 #${j.id}（${j.policy} @ ${j.version}）→ ${outcome}`);
        if (j.reason) out.push(`  - 它说：${j.reason}`);
        if (j.precondition) out.push(`  - 前提：${j.precondition}`);
        for (const item of j.items.slice(0, 5)) out.push(`  - 依据：${item}`);
        // ⚠️ 表态状态**每一条都写**，包括「没有人表态」。
        // 原来只写「有人表态过」的那种，于是「没写」在模型读来是两可的 ——
        // 实测它就自己补了一句「人已经批量确认过」，而那两条根本没人碰过。
        // 一个空字段不是「没有」，在给模型看的数据里必须写死。
        out.push(
          `  - 人的表态：${
            j.reaction
              ? `${j.reaction}（${j.reactionNote ?? '没有写原因'}）`
              : '还没有任何人表态'
          }`,
        );
      }
      out.push('');
    }
    if (f.counts.changes > f.changes.length) {
      out.push(`（只列了最近 ${f.changes.length} 次，这个窗口共 ${f.counts.changes} 次）`);
      out.push('');
    }
  }

  if (f.byProject.length) {
    out.push(`## 按项目`);
    for (const p of f.byProject) {
      const when = p.lastAt ? `，最近 ${humanTime(p.lastAt, now)}` : '';
      out.push(
        `- ${p.project || '（项目名未记录）'}：${p.changes} 次变更${when}，命中 ${p.hit}，没做成 ${p.error}，待表态 ${p.pending}`,
      );
    }
    out.push('');
  }

  if (f.byAuthor.length) {
    out.push(`## 按人`);
    for (const a of f.byAuthor) {
      out.push(`- ${a.author || '（作者未记录）'}：${a.changes} 次，其中命中 ${a.hit}`);
    }
    out.push('');
  }

  if (f.policies.length) {
    out.push(`## 两条策略验证到什么程度`);
    for (const p of f.policies) {
      out.push(
        `- ${p.policyId} @ ${p.policyVersion}：评估 ${p.total} 次，其中被人核对过 ${p.reviewed} 次，命中 ${p.hit}，判断没做成 ${p.error}`,
      );
    }
    out.push('');
  }

  out.push(`## 记录里没有的信息（问到这些要直说不知道）`);
  for (const b of f.blanks) out.push(`- ${b}`);

  return out.join('\n');
}
