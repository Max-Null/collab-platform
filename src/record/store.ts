import { DatabaseSync } from 'node:sqlite';
import type {
  JudgmentOrigin,
  JudgmentRecord,
  PolicyVersionStats,
  Reaction,
  VerdictOutcome,
} from '../types.js';

/**
 * 从 evidence_json 里取出所有 `changed_file` 指向的文件路径。
 *
 * 解析失败**不抛**，返回空集：这是给「有没有旁证」用的辅助信息，
 * 一条坏数据不该把整个列表页打挂 —— 那会让一次数据问题升级成一次不可用。
 */
function changedFilesOf(evidenceJson: string): Set<string> {
  try {
    const arr: unknown = JSON.parse(evidenceJson);
    if (!Array.isArray(arr)) return new Set();

    const out = new Set<string>();
    for (const e of arr) {
      const ev = e as { kind?: unknown; ref?: unknown };
      if (ev && typeof ev === 'object' && ev.kind === 'changed_file' && typeof ev.ref === 'string') {
        out.add(ev.ref);
      }
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * 判断记录的存储。
 *
 * 用 node:sqlite（Node 内置模块，启动时需 --experimental-sqlite）——
 * 零第三方依赖，与既有自建 MCP 的一贯风格一致。
 *
 * 为什么是数据库而不是 JSON 文件：判断记录是要长期留、要能按策略聚合查询的
 * 审计数据，观察期的统计（见 statsByPolicy）直接建在这张表上。
 */
export class RecordStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS judgment (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id       TEXT    NOT NULL,
        policy_id      TEXT    NOT NULL,
        policy_version TEXT    NOT NULL,
        outcome        TEXT    NOT NULL,
        reason         TEXT,
        precondition   TEXT,
        evidence_json  TEXT    NOT NULL,
        usage_json     TEXT,
        action         TEXT,
        action_level   INTEGER,
        external_ref   TEXT,
        undone_at      TEXT,
        origin         TEXT    NOT NULL DEFAULT 'effective',
        created_at     TEXT    NOT NULL,
        reaction       TEXT,
        reaction_note  TEXT,
        reacted_at     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_judgment_policy ON judgment(policy_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_judgment_event  ON judgment(event_id);
    `);

    const columns = this.db.prepare('PRAGMA table_info(judgment)').all() as Array<{ name: string }>;
    const names = new Set(columns.map((c) => c.name));

    // 更早的结构把反应只记成一个取值，没地方写「为什么」——
    // 而「为什么否定」恰恰是 GM 改进判据的唯一输入，不是可选的备注。
    if (!names.has('reaction_note')) {
      this.db.exec('ALTER TABLE judgment ADD COLUMN reaction_note TEXT');
    }

    // 影子的标记位现在就留，即便双轨本身还没做（见设计 §3.8）。
    // 等有数据了再补字段，已经进去的那批就再也分不出哪些是影子判定了 ——
    // 而它们会永久污染观察期的分母。
    if (!names.has('origin')) {
      this.db.exec("ALTER TABLE judgment ADD COLUMN origin TEXT NOT NULL DEFAULT 'effective'");
    }

    // 回滚要靠这两个：外部引用（收哪一条）与撤销时刻（什么时候收的）。
    // 没有它们，「发出去的评论收不回来」就永远补不上 —— 因为找不到它。
    if (!names.has('external_ref')) {
      this.db.exec('ALTER TABLE judgment ADD COLUMN external_ref TEXT');
    }
    if (!names.has('undone_at')) {
      this.db.exec('ALTER TABLE judgment ADD COLUMN undone_at TEXT');
    }

    // 结论的前提。没有它就分不出「无条件成立」与「有条件才成立」，
    // 而人对着一条条件结论只能就「对/不对」表态 —— 那个表态没有意义。
    if (!names.has('precondition')) {
      this.db.exec('ALTER TABLE judgment ADD COLUMN precondition TEXT');
    }

    // 模型用量。它回答的是「这次判断花了多少、在什么模式下判的」——
    // 而那两个答案**随配置变**：事后再去查环境变量，读到的是"现在的配置"，
    // 不是那一次生效的那份。存 JSON 而不是为每个字段开列：各家的 usage
    // 形状不一样，开列等于把厂商差异固化进 schema。
    if (!names.has('usage_json')) {
      this.db.exec('ALTER TABLE judgment ADD COLUMN usage_json TEXT');
    }

    // 更早的结构把结局存成 0/1 的 `hit` 列，表达不了第三态（判断没做成）。
    // 就地改名并换算，而不是重建表 —— 判断记录是审计数据，不该因为改结构被丢掉。
    if (names.has('hit') && !names.has('outcome')) {
      this.db.exec(`
        ALTER TABLE judgment RENAME COLUMN hit TO outcome;
        UPDATE judgment SET outcome = CASE WHEN outcome = '1' THEN 'hit' ELSE 'miss' END;
      `);
    }
  }

  /** 落一条判断记录，返回自增 id */
  save(r: JudgmentRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO judgment
        (event_id, policy_id, policy_version, outcome, reason, precondition, evidence_json, usage_json,
         action, action_level, external_ref, origin, created_at, reaction, reaction_note, reacted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      r.eventId,
      r.policyId,
      r.policyVersion,
      r.outcome,
      r.reason ?? null,
      r.precondition ?? null,
      r.evidenceJson,
      r.usageJson ?? null,
      r.action ?? null,
      r.actionLevel ?? null,
      r.externalRef ?? null,
      r.origin,
      r.createdAt,
      r.reaction ?? null,
      r.reactionNote ?? null,
      r.reactedAt ?? null,
    );
    return Number(info.lastInsertRowid);
  }

  /**
   * 补填人的反应。
   *
   * 三个取值对应观察期的三个信号：采纳 / 明确否定 / 无视。
   * 注意：只有 rejected（明确否定）进升级条件 —— 但三个都要记，
   * 因为「没改也没否定」和「明确说不对」是两种不同的东西。
   *
   * `note` 是「为什么」：判据要靠它改进，所以它进库而不只是进终端。
   */
  setReaction(id: number, reaction: Reaction, at: string, note?: string): void {
    this.db
      .prepare('UPDATE judgment SET reaction = ?, reaction_note = ?, reacted_at = ? WHERE id = ?')
      .run(reaction, note ?? null, at, id);
  }

  /**
   * 记下一次撤销。
   *
   * **不删记录，只标时刻** —— 判断记录是审计数据，「发出去了又收回」本身
   * 是该看得见的一件事，而不是一件应该消失的事。
   */
  setUndone(id: number, at: string): void {
    this.db.prepare('UPDATE judgment SET undone_at = ? WHERE id = ?').run(at, id);
  }

  /** 撤销入口要用：找出这条判定当时把动作发到哪儿去了 */
  findExternalRef(id: number): { externalRef?: string; undoneAt?: string } | undefined {
    const row = this.db
      .prepare('SELECT external_ref, undone_at FROM judgment WHERE id = ?')
      .get(id) as { external_ref: string | null; undone_at: string | null } | undefined;

    if (!row) return undefined;
    return {
      externalRef: row.external_ref === null ? undefined : String(row.external_ref),
      undoneAt: row.undone_at === null ? undefined : String(row.undone_at),
    };
  }

  /**
   * 这条判断有没有被**别的策略**旁证：同一个事件上，还有哪些策略命中了同一个文件。
   *
   * **为什么需要它**：平台的置信度原本只有一种来源 —— **人回写的反应**。
   * 那是地面真值，但它贵，贵到观察期根本转不动（跑了 100 次、99 次没人理）。
   * 而「两个独立视角都指向同一处」是一种**零人力成本**的置信度，
   * 调研里那句「交叉验证 = ≥2 个角色独立发现」说的就是这个。
   *
   * **共同锚**是 `evidence` 里的 `changed_file`（客观的文件路径）——
   * 它能被不同策略独立指向，而 `rule` 那种模型措辞不行（两条策略不可能
   * 恰好说同一句话，也不该拿这个当"重合"）。
   *
   * ⚠️ **它证明的是「不是幻觉」，不是「判断正确」。** 一条判据可以稳定地、
   * 被两个视角一致地判错。所以它只能决定「**哪些判断值得优先给人看**」，
   * 不能替代人的反应，更不能拿来自动通过任何东西。
   */
  corroborationOf(id: number): { checked: string[]; by: string[] } {
    const self = this.db
      .prepare('SELECT event_id, policy_id, evidence_json FROM judgment WHERE id = ?')
      .get(id) as { event_id: string; policy_id: string; evidence_json: string } | undefined;

    if (!self) return { checked: [], by: [] };

    const mine = changedFilesOf(self.evidence_json);

    // 同一事件、别的策略、且命中的
    const others = this.db
      .prepare(
        `SELECT policy_id, evidence_json FROM judgment
         WHERE event_id = ? AND policy_id != ? AND origin = 'effective' AND outcome = 'hit'`,
      )
      .all(self.event_id, self.policy_id) as Array<{ policy_id: string; evidence_json: string }>;

    const shared = new Set<string>();
    const by = new Set<string>();

    for (const o of others) {
      for (const f of changedFilesOf(o.evidence_json)) {
        if (mine.has(f)) {
          shared.add(f);
          by.add(String(o.policy_id));
        }
      }
    }

    return { checked: [...shared], by: [...by] };
  }

  /**
   * 按**策略 + 版本**统计 —— 这是 GM 在「该评估了」时该报的那组数。
   *
   * 刻意不提供「按策略 id 聚合成一个数」的接口：那个数会把判据改版前后的
   * 两段不可比的数据平均在一起，看起来更平滑、更像长期趋势，于是更容易被信任。
   * 想跨版本看，就自己在界面上把几行并排读 —— 至少那是诚实的。
   *
   * 影子判定（`origin = 'shadow'`）不计入分母。
   *
   * ⚠️ `reviewed` 是升级判据该用的分母，见 types.ts 里 PolicyVersionStats 的说明。
   * 「没人看过」不需要新增字段去标记 —— `reaction IS NULL` 本身就是这件事的证据。
   */
  statsByPolicyVersion(policyId?: string): PolicyVersionStats[] {
    const rows = this.db
      .prepare(
        `SELECT policy_id, policy_version,
                COUNT(*)                                                   AS total,
                SUM(CASE WHEN reaction IS NOT NULL     THEN 1 ELSE 0 END)  AS reviewed,
                SUM(CASE WHEN outcome  = 'hit'        THEN 1 ELSE 0 END)   AS hit,
                SUM(CASE WHEN outcome  = 'miss'       THEN 1 ELSE 0 END)   AS miss,
                SUM(CASE WHEN outcome  = 'error'      THEN 1 ELSE 0 END)   AS error,
                SUM(CASE WHEN reaction = 'adopted'    THEN 1 ELSE 0 END)   AS adopted,
                SUM(CASE WHEN reaction = 'rejected'   THEN 1 ELSE 0 END)   AS rejected,
                SUM(CASE WHEN reaction = 'ignored'    THEN 1 ELSE 0 END)   AS ignored
         FROM judgment
         WHERE origin = 'effective' ${policyId ? 'AND policy_id = ?' : ''}
         GROUP BY policy_id, policy_version
         ORDER BY policy_id, policy_version`,
      )
      .all(...(policyId ? [policyId] : [])) as Array<Record<string, string | number | null>>;

    return rows.map((row) => ({
      policyId: String(row.policy_id),
      policyVersion: String(row.policy_version),
      total: Number(row.total),
      reviewed: Number(row.reviewed),
      hit: Number(row.hit),
      miss: Number(row.miss),
      error: Number(row.error),
      adopted: Number(row.adopted),
      rejected: Number(row.rejected),
      ignored: Number(row.ignored),
    }));
  }

  /**
   * 查询判断记录。
   *
   * `origin` 一律带出来 —— 影子判定（草稿判据跑出来的）从来没被人看见过，
   * 拿它当「GM 做过的事」会把「GM 判了多少次」这个数翻倍。
   */
  private query(where: string, params: Array<string | number | null>, limit: number): JudgmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, event_id, policy_id, policy_version, outcome, reason, precondition, evidence_json, usage_json,
                action, action_level, external_ref, undone_at,
                origin, created_at, reaction, reaction_note, reacted_at
         FROM judgment ${where} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: Number(row.id),
      eventId: String(row.event_id),
      policyId: String(row.policy_id),
      policyVersion: String(row.policy_version),
      outcome: String(row.outcome) as VerdictOutcome,
      reason: row.reason === null ? undefined : String(row.reason),
      precondition: row.precondition === null ? undefined : String(row.precondition),
      evidenceJson: String(row.evidence_json),
      usageJson:
        row.usage_json === null || row.usage_json === undefined
          ? undefined
          : String(row.usage_json),
      action: row.action === null ? undefined : String(row.action),
      actionLevel: row.action_level === null ? undefined : Number(row.action_level),
      externalRef: row.external_ref === null ? undefined : String(row.external_ref),
      undoneAt: row.undone_at === null ? undefined : String(row.undone_at),
      origin: String(row.origin) as JudgmentOrigin,
      createdAt: String(row.created_at),
      reaction: row.reaction === null ? undefined : (String(row.reaction) as Reaction),
      reactionNote: row.reaction_note === null ? undefined : String(row.reaction_note),
      reactedAt: row.reacted_at === null ? undefined : String(row.reacted_at),
    }));
  }

  /** 最近的判断记录，倒序。默认只看生效判定 —— 影子不进正常列表。 */
  listRecent(limit = 20): JudgmentRecord[] {
    return this.query("WHERE origin = 'effective'", [], limit);
  }

  /**
   * 还没被人表过态的判定 —— 控制台的「待办」就是它。
   *
   * **只收「命中」与「判断没做成」**：
   * · 未命中是「看过，没问题」，它没有主张需要人确认 —— 列进待办只会把第一屏
   *   变成数据总览，而第一屏一旦变成总览，打开两次就不会再打开了；
   * · 判断没做成虽然没有主张，但它比命中更需要人看见（可能是模型没配、取数失败）。
   */
  listPendingReactions(limit = 50): JudgmentRecord[] {
    return this.query(
      "WHERE reaction IS NULL AND outcome IN ('hit', 'error') AND origin = 'effective'",
      [],
      limit,
    );
  }

  /** 判断没做成、且还没被回应的 —— 它比「命中」更需要人看见 */
  listUnresolvedErrors(limit = 50): JudgmentRecord[] {
    return this.query(
      "WHERE outcome = 'error' AND reaction IS NULL AND origin = 'effective'",
      [],
      limit,
    );
  }

  findById(id: number): JudgmentRecord | undefined {
    return this.query('WHERE id = ?', [id], 1)[0];
  }

  /**
   * 这条事件在「这条策略的这个版本」下判过没有。
   *
   * 轮询会反复拉到同一个 MR（事件 id 里带 commit sha，所以只有 MR 没变时才会撞上）。
   * 没有这个判断，每轮一次就多一条记录 —— 而观察期的分母是「被评估了多少次」，
   * 重复计数会让它凭空变大，且这种污染是**静默的**：数据看起来只是更多了。
   */
  hasJudged(eventId: string, policyId: string, policyVersion: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM judgment
         WHERE event_id = ? AND policy_id = ? AND policy_version = ? LIMIT 1`,
      )
      .get(eventId, policyId, policyVersion);
    return row !== undefined;
  }

  /**
   * 运行图要的那组数 —— 一次查询汇总，不来回拉全表。
   *
   * 刻意只算 `origin = 'effective'`：影子判定没有动作、也不进人的视野，
   * 混进来会让「事件 → 策略 → 判定 → 动作 → 留痕」这四段的数目对不上账，
   * 而对不上账的流程图比没有流程图更糟 —— 人会以为是自己看错了。
   */
  flow(): {
    events: number;
    judgments: number;
    hit: number;
    miss: number;
    error: number;
    actions: number;
    reacted: number;
    pending: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(DISTINCT event_id)                                  AS events,
           COUNT(*)                                                  AS judgments,
           SUM(CASE WHEN outcome  = 'hit'   THEN 1 ELSE 0 END)       AS hit,
           SUM(CASE WHEN outcome  = 'miss'  THEN 1 ELSE 0 END)       AS miss,
           SUM(CASE WHEN outcome  = 'error' THEN 1 ELSE 0 END)       AS error,
           SUM(CASE WHEN action IS NOT NULL THEN 1 ELSE 0 END)       AS actions,
           SUM(CASE WHEN reaction IS NOT NULL THEN 1 ELSE 0 END)     AS reacted
         FROM judgment WHERE origin = 'effective'`,
      )
      .get() as Record<string, number | null>;

    const pending = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM judgment
           WHERE origin = 'effective' AND reaction IS NULL AND outcome IN ('hit', 'error')`,
        )
        .get() as { n: number }
    ).n;

    return {
      events: row.events ?? 0,
      judgments: row.judgments ?? 0,
      hit: row.hit ?? 0,
      miss: row.miss ?? 0,
      error: row.error ?? 0,
      actions: row.actions ?? 0,
      reacted: row.reacted ?? 0,
      pending,
    };
  }

  close(): void {
    this.db.close();
  }
}
