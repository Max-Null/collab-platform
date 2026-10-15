import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitLabPollSource } from './event/gitlab.js';
import { GitLabPushSource } from './event/gitlab-push.js';
import { MockEventSource } from './event/mock.js';
import type { EventSource } from './event/source.js';
import { GitLabApi, fetchOAuthToken } from './gitlab/api.js';
import { runPipeline } from './pipeline.js';
import { judgeHealth } from './policy/health.js';
import type { PipelineResult } from './types.js';
import { describeUsage } from './usage.js';
import { wire } from './wiring.js';
import type { GitLabWiring } from './wiring.js';

const root = process.cwd();

const { values } = parseArgs({
  options: {
    source: { type: 'string', default: 'mock' },
    events: { type: 'string', default: 'fixtures/events' },
    db: { type: 'string', default: 'var/platform.db' },
    out: { type: 'string', default: 'var/comments' },
    stats: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const log = (msg: string): void => {
  process.stdout.write(`${msg}\n`);
};

const eventsDir = resolve(root, values.events);
const dbPath = values.db === ':memory:' ? ':memory:' : resolve(root, values.db);
const outDir = resolve(root, values.out);

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`事件源选 gitlab 时必须配环境变量 ${name}`);
  return value;
}

let source: EventSource;
let gitlab: GitLabWiring | undefined;
let sourceNote: string;

if (values.source === 'gitlab' || values.source === 'gitlab-push') {
  const baseUrl = need('GITLAB_BASE_URL');
  const project = need('GITLAB_PROJECT');
  const write = process.env.GITLAB_WRITE === 'true';

  // 两种凭据形态：Personal Access Token 优先（不过期、权限可以只给 read_api）；
  // 没有就退回用户名密码换 OAuth 令牌 —— 那条路两小时过期，只适合先跑起来看一眼。
  let api: GitLabApi;
  const pat = process.env.GITLAB_TOKEN;
  if (pat) {
    api = new GitLabApi({ baseUrl, token: pat });
  } else {
    const username = need('GITLAB_USER');
    const password = need('GITLAB_PASSWORD');
    const token = await fetchOAuthToken({ baseUrl, username, password });
    api = new GitLabApi({
      baseUrl,
      token,
      tokenKind: 'bearer',
      // 常驻要跑几天，而这条令牌两小时就过期 —— 让它自己在 401 时换一个（见 api.ts 的 req）
      refresh: () => fetchOAuthToken({ baseUrl, username, password }),
    });
  }

  const state = process.env.GITLAB_MR_STATE ?? 'opened';
  gitlab = { api, project, write };

  if (values.source === 'gitlab-push') {
    // 推送链路。团队不用 MR 时，只订阅 MR 的平台会「每轮成功、每轮 0 个事件」——
    // 那与「真的没有变更」长得一模一样，而它其实什么都没看到。
    const branch = process.env.GITLAB_BRANCH;
    source = new GitLabPushSource(api, project, {
      branch,
      limit: Number(process.env.GITLAB_COMMIT_LIMIT ?? 20),
    });
    sourceNote =
      `gitlab-push · ${project} · 分支 ${branch ?? '（默认分支）'} · ` +
      `${write ? '写开关【开】' : '写开关【关】（dry-run）'}`;
  } else {
    source = new GitLabPollSource(api, project, {
      limit: Number(process.env.GITLAB_MR_LIMIT ?? 20),
      state,
    });
    sourceNote =
      `gitlab · ${project} · state=${state} · ` +
      `${write ? '写开关【开】' : '写开关【关】（dry-run）'}`;
  }
} else {
  source = new MockEventSource(eventsDir);
  sourceNote = `mock · ${eventsDir}`;
}

// ── 装配（与 MCP 出口共用同一条路径）────────────────────
const w = wire({ root, dbPath, outDir, gitlab });

// ── 跑 ──────────────────────────────────────────────────
const events = await source.fetch();

log(
  `[协作平台] 事件源 ${sourceNote} · 策略 ${w.policies.length} 条 · ` +
    `判断模型 ${w.llm.name}/${w.llm.model} · 本次事件 ${events.length} 个`,
);

const results: PipelineResult[] = [];
for (const event of events) {
  log('');
  log(`── ${event.id} ${'─'.repeat(Math.max(0, 46 - event.id.length))}`);
  log(`  MR !${event.mrIid} ${event.title}（${event.author}）`);

  const result = await runPipeline(event, {
    policies: w.policies,
    actions: w.actions,
    store: w.store,
  });
  results.push(result);

  // 用量单独一行：它回答的是「这次判断花了多少、有没有思考」，
  // 与结论是什么无关 —— 所以三种结局都要打
  const logUsage = (v: (typeof result.verdicts)[number]): void => {
    const usage = describeUsage(v.modelUsage);
    if (usage) log(`    用量：${usage}`);
  };

  for (const v of result.verdicts) {
    const head = `${v.policyId} @ ${v.policyVersion}`;

    if (v.outcome === 'miss') {
      log(`  · ${head} 未命中（看过，没问题）`);
      logUsage(v);
      continue;
    }

    if (v.outcome === 'error') {
      log(`  ⚠ ${head} 判断没做成 —— 这不等于通过`);
      log(`    ${v.reason ?? ''}`);
      for (const e of v.evidence) log(`    · ${e.kind} ${e.detail}`);
      logUsage(v);
      continue;
    }

    log(`  ✓ ${head} 命中`);
    log(`    ${v.reason ?? ''}`);
    for (const e of v.evidence) {
      log(`    · ${e.kind} ${e.detail}${e.ref ? `（出处：${e.ref}）` : ''}`);
    }
    logUsage(v);
  }

  for (const a of result.actions) {
    log(`  → 动作 ${a.action} 已执行${a.ok ? '' : `（失败：${a.error ?? ''}）`}`);
  }
}

const totalRecorded = results.reduce((n, r) => n + r.recorded, 0);
log('');
log(`落判断记录 ${totalRecorded} 条 → ${dbPath}`);
log(`评论正文 → ${outDir}`);

// ── 观察期数据（GM「报数据」而不是「要权限」时给出的东西）─
if (values.stats) {
  log('');
  log('── 观察期统计（按策略版本）──────────────');
  for (const p of w.policies) {
    const rows = w.store.statsByPolicyVersion(p.id);
    if (rows.length === 0) {
      log(`  ${p.id}：还没有评估记录`);
      continue;
    }
    for (const s of rows) {
      log(
        `  ${s.policyId} @ ${s.policyVersion}：评估 ${s.total} 次 · **看过 ${s.reviewed}** · ` +
          `命中 ${s.hit} · 未命中 ${s.miss} · 判断没做成 ${s.error} · ` +
          `采纳 ${s.adopted} · 明确否定 ${s.rejected} · 无视 ${s.ignored}`,
      );

      // 「拦不住 / 没什么可拦 / 根本没开 / 从没真的判断过」四者必须分得开
      // —— 见 policy/health.ts。所以 error 也要传进去，不能只给 total 与 hit。
      const h = judgeHealth({
        enabled: p.enabled !== false,
        total: s.total,
        hit: s.hit,
        error: s.error,
      });
      if (h.health !== 'ok') log(`    ⚠ ${h.note}`);
    }
  }
  log('  （按版本切分 —— 判据改过之后，命中率与之前根本不可比，聚成一个数只会更好看）');
  log('  （升级判据的分母是「看过」，不是「评估」—— 用评估当分母等于用冷漠稀释信号）');
  log('  （只有「明确否定」进升级条件；「判断没做成」单独一列，不许并进未命中）');
}

w.store.close();
