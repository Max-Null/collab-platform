import { judgeDaemon, summarizeFailures, toBeatSlots } from '../heartbeat.js';
import { judgeHealth } from '../policy/health.js';
import type { wire } from '../wiring.js';

/**
 * `/api/overview` 的那份数据 —— **单独一个模块**，因为它有两个调用方。
 *
 * 除了控制台，`scripts/make-live-diagram.mjs` 也要它：双击打开的静态图里，
 * 状态是生成时**烤进去**的，而烤进去的必须是同一份东西 —— 两处各写一遍的话，
 * 界面上的数字与图上的标记迟早会对不上，而那种不一致**不会报错**。
 */
export function buildOverview(w: ReturnType<typeof wire>, dbPath: string): Record<string, unknown> {
  const pending = w.store.listPendingReactions(200);
  const errors = w.store.listUnresolvedErrors(200);
  const lastBeat = w.store.lastHeartbeat();
  const lastJudgmentAt = w.store.lastJudgmentAt();

  return {
    policies: w.policies.map((p) => ({
      id: p.id,
      version: p.version,
      description: p.description,
      disposal: p.disposal,
    })),
    // 统计里带上健康判定 —— 判据只该有一处（policy/health.ts），
    // 前端不自己算，否则两边迟早给出不同结论
    stats: w.store.statsByPolicyVersion().map((s) => {
      const p = w.policies.find((x) => x.id === s.policyId);
      return {
        ...s,
        health: judgeHealth({
          enabled: p?.enabled !== false,
          total: s.total,
          hit: s.hit,
          error: s.error,
        }),
      };
    }),
    /** 运行图要的四段数字。四段的数目要能对得上账，否则人看图会以为是自己看错了。 */
    flow: w.store.flow(),
    pendingCount: pending.length,
    // 「判断没做成」单独计数：它比命中更需要人看见，也不是「未命中」
    errorPendingCount: errors.length,
    model: { name: w.llm.name, model: w.llm.model, configured: w.llmConfigured },
    dbPath,
    /**
     * 平台**现在**的状态 —— 与上面每一个数都不同性质。
     *
     * 上面那些回答的是「它做过什么」，而累计数字永远看起来像「一直都在
     * 正常工作」：一个停了 21 小时的平台，它的累计统计与一个正在跑的
     * 一模一样。这一项回答的是「它还在不在」，判据在 heartbeat.ts。
     */
    daemon: {
      ...judgeDaemon({ last: lastBeat, lastJudgmentAt }),
      last: lastBeat ?? null,
      lastJudgmentAt: lastJudgmentAt ?? null,
      /**
       * 最近的心跳，按时间正序 —— 状态卡上那排格带用它。
       *
       * 与 `last` 是两种东西：`last` 回答「此刻还在不在」，格带回答
       * 「**最近稳不稳**」—— 「每隔几轮就迟一次」与「一直很稳」在后者眼里
       * 完全不同，而在只有一个圆点的界面里长得一模一样。
       */
      beats: toBeatSlots(w.store.recentHeartbeats(200), { now: new Date(), slots: 48 }),
    },
    /**
     * 最近 7 天有没有**连着**失败过。
     *
     * 与 `daemon.beats` 是两种窗口：格带铺最近 48 片（约 4 小时），回答「现在稳不稳」；
     * 这一项回答「**这段时间出过事没有**」—— 昨天连不上三小时那类事，早滑出格带了，
     * 而库里是全的。判据（连片才算、隔太久断开）在 heartbeat.ts。
     */
    failures:
      summarizeFailures(w.store.heartbeatsSince(new Date(Date.now() - 7 * 86400_000).toISOString())) ??
      null,
  };
}
