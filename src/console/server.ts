import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildOverview } from './overview.js';
import { failureRuns } from '../heartbeat.js';
import { judgeHealth } from '../policy/health.js';
import { parseUsage } from '../usage.js';
import { wire } from '../wiring.js';
import type { Reaction } from '../types.js';

/**
 * 控制台的服务端。
 *
 * 一个进程做两件事：把 `public/console.html` 发出去，把判断记录以 JSON 发出去。
 * 用 `node:http`，零第三方依赖。
 *
 * 三条约定：
 * ① **只读为主，唯一的写是回写反应**。控制台不给「改策略」这类能力留后门 ——
 *    那要等策略版本历史与回滚就位（阶段四）。
 * ② **JSON 一律带 charset=utf-8**。中文在这个页面上到处都是，漏了 charset
 *    的表现是「页面能开、中文全是问号」，而排查时容易怀疑数据而不是响应头。
 * ③ **数字都能走回来源**。每个统计旁边给的入口，指向的是原始判断记录 ——
 *    控制台上的数字要么来自判断记录、要么来自 GitLab 的客观事实，没有第三个来源。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8790' },
    db: { type: 'string', default: 'var/platform.db' },
    out: { type: 'string', default: 'var/comments' },
    // 活点地图（设计链路 + 此刻状态）由 make-live-diagram 生成到这里
    diagram: { type: 'string', default: 'var/diagram/live.html' },
    // 母机的结构图 —— 另起一个路由而不是塞进 /diagram：两张图回答不同的问题
    map: { type: 'string', default: 'var/diagram/architecture.html' },
  },
  allowPositionals: false,
});

const dbPath = values.db === ':memory:' ? ':memory:' : resolve(root, values.db);
const w = wire({ root, dbPath, outDir: resolve(root, values.out) });

// 每次请求都重读页面：改一句文案不必重启服务。
// 控制台是给人看的，而「改一句话要重启一次」会让人干脆不改文案。
const page = (): string => readFileSync(resolve(root, 'public/console.html'), 'utf8');

const log = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** 把一条 judgment 记录整成控制台要的形状（含拆开后的依据） */
function shape(r: ReturnType<typeof w.store.listRecent>[number]) {
  let evidence: unknown[] = [];
  try {
    evidence = JSON.parse(r.evidenceJson) as unknown[];
  } catch {
    // 依据解析不出来时不要静默丢掉 —— 那是排查时最需要看到的东西
    evidence = [{ kind: 'rule', detail: `依据无法解析：${r.evidenceJson.slice(0, 200)}` }];
  }

  return {
    id: r.id,
    eventId: r.eventId,
    // 事件快照 —— 让每一条判定都能自己说明「判的是谁的哪次变更」。
    // 老记录这里是 null：那时没记，如实给 null，不拿现在的配置去补。
    project: r.project ?? null,
    author: r.author ?? null,
    title: r.title ?? null,
    eventKind: r.eventKind ?? null,
    changedFiles: r.changedFiles ?? null,
    sha: r.sha ?? null,
    mrIid: r.mrIid ?? null,
    policyId: r.policyId,
    policyVersion: r.policyVersion,
    outcome: r.outcome,
    reason: r.reason ?? null,
    precondition: r.precondition ?? null,
    evidence,
    // 用量：这一条判定里模型调用花了多少（纯规则策略为 null）。
    // 它随配置变，所以必须跟着记录走 —— 事后再去查环境变量，读到的是"现在的配置"。
    usage: parseUsage(r.usageJson) ?? null,
    // id 一定有（这是从库里读出来的记录），但类型上 save() 的入参允许没有 id
    corroboration: r.id === undefined ? { checked: [], by: [] } : w.store.corroborationOf(r.id),
    action: r.action ?? null,
    actionLevel: r.actionLevel ?? null,
    origin: r.origin,
    createdAt: r.createdAt,
    reaction: r.reaction ?? null,
    reactionNote: r.reactionNote ?? null,
    reactedAt: r.reactedAt ?? null,
  };
}

function handle(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const path = url.pathname;

  if (path === '/' || path === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page());
    return;
  }

  // 两张活点地图：`/diagram` 是一次变更怎么走（流程），`/map` 是母机由什么组成（结构）。
  // 它们回答不同的问题，所以是两个路由而不是一个带参数的路由 —— 名字本身就是答案的一半。
  if (path === '/diagram' || path === '/map') {
    const rel = path === '/map' ? values.map : values.diagram;
    const file = resolve(root, rel);
    let html: string | undefined;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      html = undefined;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(
      html ??
        // 没生成时不说 404 —— 404 的意思是「路径写错了」，而这里是「还没做」，
        // 两者要做的事完全不同（一个去查路径，一个去跑那条命令）。
        `<!doctype html><meta charset="utf-8"><title>活点地图 · 还没生成</title>
         <body style="font:15px/1.8 system-ui,sans-serif;max-width:38em;margin:5em auto;padding:0 1.5em;color:#333">
         <h1 style="font-size:1.25em">这张图还没生成</h1>
         <p>它把<b>设计上的结构与链路</b>与<b>此刻每一步的真实状态</b>叠在一起 —— 所以得生成一次才存在。</p>
         <p>在仓库根目录跑：<code style="background:#f2f2f2;padding:.15em .4em;border-radius:3px">npm run diagram:live</code>（流程：一次变更怎么走）<br>
            或者 <code style="background:#f2f2f2;padding:.15em .4em;border-radius:3px">npm run diagram:map</code>（结构：母机由什么组成）</p>
         <p style="color:#888;font-size:.9em">这个地址对应：<code>${rel}</code></p>
         <p><a href="/">← 回控制台</a></p></body>`,
    );
    return;
  }

  if (path === '/api/overview') {
    // 组装逻辑在 console/overview.ts：活点地图的静态快照也要同一份。
    // 两处各写一遍的话，界面上的数字与图上的标记迟早会对不上 —— 而那种不一致不会报错。
    return json(res, buildOverview(w, dbPath));
  }

  /**
   * 项目视图 —— 控制台第一屏要的那份数据。
   *
   * 与 `/api/overview` 的差别是**主语**，不是数据量：那边回答「平台自己怎么样」
   * （心跳、四段计数、策略命中率），这边回答「我的项目现在怎么样」。两个都要，
   * 但不能挤在同一屏 —— 挤在一起的结果是管理员得先学会运维概念，才看得懂自己的项目。
   */
  if (path === '/api/project-view') {
    const ov = buildOverview(w, dbPath) as {
      daemon: { status: string; note: string };
      model: { name: string; model: string; configured: boolean };
    };

    const changes = w.store.listChanges(60);
    const projects = w.store.projectSummaries();
    const judgedChanges = projects.reduce((n, p) => n + p.changes, 0);

    /**
     * 「这份数据现在代表什么」—— 四种状态，四件不同的事。
     *
     * 这是这个平台全篇的靶子，落到它自己的第一屏上：
     * - `live`         常驻在跑，列表反映的是此刻
     * - `stale`        **有数据，但没人在看**。底下全是历史 —— 而它看起来
     *                  与「最近真的没有变更」一模一样，这正是最危险的那一种
     * - `never-judged` 一条都没判过：还没接上，不是「项目干净」
     * - `idle`         在看着，但还没有变更进来
     *
     * ⚠️ `stale` 单独成态，而不是并进「有数据就正常」—— 一个停了三天的平台，
     * 它的列表与一个正在跑的平台长得完全一样，只有这个字段能把它们分开。
     */
    const alive = ov.daemon.status === 'alive';
    const viewState =
      changes.length > 0
        ? alive
          ? 'live'
          : 'stale'
        : judgedChanges === 0
          ? alive
            ? 'idle'
            : 'never-judged'
          : 'stale';

    return json(res, {
      projects,
      changes,
      /** 列出来的与全量的差别 —— 界面上要能说清「这是最近 60 次」 */
      shown: changes.length,
      judgedChanges,
      viewState,
      daemon: ov.daemon,
      model: ov.model,
    });
  }

  /**
   * 失败轮次的明细 —— 图上「连片失败过 N 轮」那个标记点开看的就是它。
   *
   * 与 `/api/overview` 里的 `failures` 是同一份数据的两种粒度：那边给结论
   * （最长多少轮、共失败多少），这边给**证据**（每一段的时刻、每轮的错误原文）。
   * 切段的判据只有一处（`failureRuns`），所以两个数字不会对不上。
   */
  if (path === '/api/failures') {
    const raw = Number(url.searchParams.get('days') ?? 7);
    const days = Number.isFinite(raw) && raw > 0 && raw <= 90 ? raw : 7;
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const beats = w.store.heartbeatsSince(since);

    return json(res, {
      window: { since, days },
      total: beats.length,
      failed: beats.filter((b) => !b.ok).length,
      // 最近的段排前面 —— 人找的是「最近一次什么时候断的」
      runs: failureRuns(beats)
        .slice()
        .reverse()
        .map((r) => ({
          from: r.from,
          to: r.to,
          count: r.count,
          errors: r.errors,
          beats: r.beats.map((b) => ({
            at: b.at,
            events: b.events,
            judged: b.judged,
            skipped: b.skipped,
            durationMs: b.durationMs,
            error: b.error ?? null,
          })),
        })),
    });
  }

  if (path === '/api/pending') {    const rows = w.store.listPendingReactions(200);

    // 排序：判断没做成的排前面 —— 它不是「有问题」，是「这次没看」，
    // 而没看比看错了更容易被忽略，因为它不留痕迹
    rows.sort((a, b) => {
      if (a.outcome !== b.outcome) {
        if (a.outcome === 'error') return -1;
        if (b.outcome === 'error') return 1;
      }
      return (b.id ?? 0) - (a.id ?? 0);
    });

    return json(res, { rows: rows.map(shape) });
  }

  if (path === '/api/judgments') {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const policy = url.searchParams.get('policy');
    const outcome = url.searchParams.get('outcome');

    let rows = w.store.listRecent(Number.isFinite(limit) ? limit : 100);
    if (policy) rows = rows.filter((r) => r.policyId === policy);
    if (outcome) rows = rows.filter((r) => r.outcome === outcome);

    return json(res, { rows: rows.map(shape) });
  }

  const detail = /^\/api\/judgment\/(\d+)$/.exec(path);
  if (detail) {
    const row = w.store.findById(Number(detail[1]));
    if (!row) return json(res, { error: `没有 id 为 ${detail[1]} 的判断记录` }, 404);
    return json(res, shape(row));
  }

  if (path === '/api/stats') {
    // 健康判定跟统计一起给：判据只有一处（policy/health.ts），前端不自己算。
    // 它回答的是「这条策略被验证过没有」—— 与命中率是两个问题，
    // 而「跑得少」看起来和「跑得好」在数字上一模一样（都是 0 命中）。
    return json(res, {
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
    });
  }

  if (path === '/api/reaction' && req.method === 'POST') {
    void (async () => {
      try {
        const body = await readBody(req);

        // 支持一次表一批。**为什么要有它**：调研里那句「循环取胜的前提是
        // 验证成本低廉」—— 逐条回写是一次高成本验证，成本高到没人做，
        // 于是观察期永远攒不出数据。批量是让这个环转起来的一条路。
        //
        // ⚠️ 但批量**必须留下「它是批量的」这个痕迹**：观察期的分母包含批量表态，
        // 而「一键全选这批都对」与「逐条看过」的信息量不同。事后分不清这两者，
        // 就等于又一次用好看的数字盖住真实的情况。
        const ids: number[] = Array.isArray(body.judgmentIds)
          ? body.judgmentIds.map((x: unknown) => Number(x))
          : [Number(body.judgmentId)];

        const reaction = body.reaction as Reaction;
        const note = typeof body.note === 'string' ? body.note.trim() : '';

        if (ids.length === 0) return json(res, { error: '没有给要表态的记录' }, 400);
        if (ids.some((i) => !Number.isInteger(i))) {
          return json(res, { error: 'judgmentId / judgmentIds 必须是整数' }, 400);
        }
        if (reaction !== 'adopted' && reaction !== 'rejected' && reaction !== 'ignored') {
          return json(res, { error: 'reaction 只能是 adopted / rejected / ignored' }, 400);
        }

        const missing = ids.filter((i) => !w.store.findById(i));
        if (missing.length > 0) {
          return json(res, { error: `这些 id 不存在：${missing.join(', ')}` }, 404);
        }

        const isBatch = ids.length > 1;
        const finalNote = isBatch
          ? [note, `**批量表态**（一次 ${ids.length} 条）`].filter(Boolean).join(' · ')
          : note || undefined;

        const at = new Date().toISOString();
        for (const id of ids) w.store.setReaction(id, reaction, at, finalNote);

        return json(res, {
          ok: true,
          count: ids.length,
          judgmentIds: ids,
          reaction,
          // 如实告诉前端 note 被追加了什么 —— 别让调用方以为它原样存了
          note: finalNote ?? null,
          batch: isBatch,
        });
      } catch (e) {
        return json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
      }
    })();
    return;
  }

  json(res, { error: `没有这个路由：${path}` }, 404);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${values.port}`);
  try {
    handle(req, res, url);
  } catch (e) {
    json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

const port = Number(values.port);

server.listen(port, () => {
  log(`[协作平台 · 控制台] http://127.0.0.1:${port}`);
  log(`  库：${dbPath}`);
  log(
    `  策略 ${w.policies.length} 条 · 模型 ${
      w.llmConfigured ? `${w.llm.name}/${w.llm.model}` : '未配置（第二条策略会落 error）'
    }`,
  );
  log('  身份自报，界面上标明未经验证 —— 这是流程约束，不是权限');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    w.store.close();
    server.close();
    process.exit(0);
  });
}
