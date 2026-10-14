import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
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

  if (path === '/api/overview') {
    const stats = w.store.statsByPolicyVersion();
    const pending = w.store.listPendingReactions(200);
    const errors = w.store.listUnresolvedErrors(200);

    return json(res, {
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
    });
  }

  if (path === '/api/pending') {
    const rows = w.store.listPendingReactions(200);

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
    return json(res, { stats: w.store.statsByPolicyVersion() });
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
