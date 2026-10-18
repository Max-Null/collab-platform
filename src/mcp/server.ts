import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { JudgmentRecord } from '../types.js';
import type { PipelineResult } from '../types.js';
import { ask } from '../butler/ask.js';
import { describeUsage, parseUsage } from '../usage.js';
import { runPipeline } from '../pipeline.js';
import { judgeHealth } from '../policy/health.js';
import { wire } from '../wiring.js';
import type { Wiring } from '../wiring.js';

/**
 * 平台的 MCP 出口。
 *
 * 人和 Agent 从这里接入，走的是与 CLI **同一套装配**（见 wiring.ts）——
 * 平台对同一次变更给出什么结论，不该取决于你是从哪个入口进来的。
 *
 * 三条约定：
 * ① **stdout 只走协议**。任何日志、报错都走 stderr，否则会污染 JSON-RPC 流，
 *    而表现是「连接莫名断开」，排查时看不出跟日志有关。
 * ② **写操作一律留痕**。`submit_change` 跑完整管道并落判断记录，
 *    `record_reaction` 直接进库 —— 这个出口没有「只试试不留下痕迹」的路径。
 * ③ **拿不到就说拿不到**。判断没做成时返回的是 error 结局的说明，
 *    不是「没有发现问题」——这两句话在人读来差别很大。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();
const dbRaw = process.env.COLLAB_DB ?? 'var/platform.db';
const dbPath = dbRaw === ':memory:' ? ':memory:' : resolve(root, dbRaw);
const outDir = resolve(root, process.env.COLLAB_OUT ?? 'var/comments');

/** 使用指引的位置 —— 平台对外发的「用法」只有这一份 */
const USAGE_GUIDE = 'skills/platform-usage/SKILL.md';

const w: Wiring = wire({ root, dbPath, outDir });

const log = (msg: string): void => {
  process.stderr.write(`[collab-platform] ${msg}\n`);
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ── 输出格式 ────────────────────────────────────────────

function renderRows(rows: JudgmentRecord[]): string {
  if (rows.length === 0) return '（没有判断记录）';

  return rows
    .map((r) => {
      const lines = [
        `#${r.id} [${r.outcome}] ${r.policyId} @ ${r.policyVersion}`,
        `  事件：${r.eventId}`,
        `  结论：${r.reason ?? '（没有给出说明）'}`,
      ];
      if (r.action) lines.push(`  动作：${r.action}（处置级别 ${r.actionLevel}）`);
      if (r.reaction) {
        lines.push(`  人的反应：${r.reaction}${r.reactionNote ? ` —— ${r.reactionNote}` : ''}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function renderPipelineResult(result: PipelineResult): string {
  const lines = [`事件 ${result.event.id}（MR !${result.event.mrIid}）已判定。`, ''];

  for (const v of result.verdicts) {
    const tag =
      v.outcome === 'hit' ? '命中' : v.outcome === 'miss' ? '未命中' : '判断没做成（不等于通过）';
    lines.push(`- ${v.policyId} @ ${v.policyVersion}：${tag}`);
    if (v.reason) lines.push(`  ${v.reason}`);

    // 申报的人也该看得见这次判断花了多少 ——「成本可见」是这条改动的目的之一
    const usageText = describeUsage(v.modelUsage);
    if (usageText) lines.push(`  用量：${usageText}`);
  }

  if (result.actions.length > 0) {
    lines.push('', '产生的动作：');
    for (const a of result.actions) {
      lines.push(`- ${a.action}${a.ok ? '' : `（失败：${a.error ?? ''}）`}`);
    }
  }

  lines.push('', `落判断记录 ${result.recorded} 条。`);
  return lines.join('\n');
}

// ── 工具定义 ────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'ask_butler',
    description:
      '问管家一句话，得到一段基于记录的**人话回答**（不是一堆数据）。' +
      '它读判断记录、心跳与观察期统计，回答里每条具体结论都带（#编号），可以直接用 get_judgment 追问。' +
      '适用：「昨天有什么动静」「谁改得最多」「那条可疑的后来怎么样了」。' +
      '⚠️ 记录里没有的信息（变更的动机、任务排期、谁是负责人）它会直说不知道 —— 那不是失败，是不编。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '用日常说法问，例如「昨天有什么动静」' },
        hours: {
          type: 'number',
          description: '看多长时间（小时）。不填就按问题里的日期词判断（昨天=24、上周=168…）',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_usage_guide',
    description:
      '平台的使用指引（给接入的 Agent）：什么时候该找平台、三种动作分别怎么用、最容易写错的地方在哪里。第一次接入、或不确定某一步该不该做时读它。注意：它只讲用法，「有哪些工具」以 tools/list 为准 —— 不在这里重复一份。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_judgments',
    description:
      '看平台最近的判断记录（谁被判定成什么、依据是什么、人有没有回写反应）。用于接手一条工作线时先了解「平台已经看过什么」。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 20' },
        policyId: { type: 'string', description: '只看某条策略，可选' },
      },
    },
  },
  {
    name: 'get_judgment',
    description: '看一条判断记录的完整内容，含全部依据（命中的文件、取数来源、判断模型）。',
    inputSchema: {
      type: 'object',
      properties: { judgmentId: { type: 'number', description: '判断记录 id' } },
      required: ['judgmentId'],
    },
  },
  {
    name: 'policy_stats',
    description:
      '看各条策略的观察期统计：评估次数、命中次数、判断没做成的次数、人的采纳 / 否定 / 无视。用于判断一条判据该不该升级或收回。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_policies',
    description: '看平台当前装了哪些策略、各自的版本、判据说明与处置级别。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'submit_change',
    description:
      '把一次变更交给平台判定。这是 Agent 主动申报的入口 —— 干完活之后把改了什么、声称做了什么交代清楚，平台会跑完所有策略并留下判断记录。注意：title 与 description 是**被检验的主张**，changedFiles 与 diff 才是判断依据。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目路径，如 my-group/my-app' },
        mrIid: { type: 'number', description: '变更编号（MR 的 iid，或你自己编的序号）' },
        title: { type: 'string', description: '这次变更声称做了什么' },
        description: { type: 'string', description: '更详细的说明，可选' },
        author: { type: 'string', description: '提交者，可选' },
        targetBranch: { type: 'string', description: '目标分支，可选' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: '改动的文件路径（仓库根相对）',
        },
        diff: { type: 'string', description: '完整 diff。缺了它「改动与声称」那条策略会落 error' },
        eventId: { type: 'string', description: '自定义事件 id，可选' },
      },
      required: ['project', 'mrIid', 'title', 'changedFiles'],
    },
  },
  {
    name: 'record_reaction',
    description:
      '回写人对某条判断的反应。这是观察期升级的唯一输入：只有 rejected（明确否定）进升级条件，adopted 与 ignored 都记但不当判据。note 请写清「为什么」—— 判据要靠它改进。',
    inputSchema: {
      type: 'object',
      properties: {
        judgmentId: { type: 'number', description: '判断记录 id' },
        reaction: { type: 'string', enum: ['adopted', 'rejected', 'ignored'] },
        note: { type: 'string', description: '为什么这么反应' },
      },
      required: ['judgmentId', 'reaction'],
    },
  },
];

// ── 工具实现 ────────────────────────────────────────────

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'ask_butler': {
      const question = str(args, 'question')?.trim();
      if (!question) return err('ask_butler 需要 question（一句话，用日常说法问）');

      const rawHours = Number(args.hours);
      const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : undefined;

      const res = await ask(question, {
        store: w.store,
        llm: w.llm,
        llmConfigured: w.llmConfigured,
        hours,
      });

      // 拿不到就说拿不到 —— 与判断没做成时同一个判据。
      // 组装成一句「我已看过」而其实没看，是这个出口最坏的失效形态。
      if (!res.ok) return err(res.error ?? '这次没有回答');

      return ok(res.answer ?? '');
    }

    case 'get_usage_guide': {
      // 每次现读：指引是要反复改的东西，缓存一份就等于多了一个会过期的副本。
      // 两条路（这个工具 / 技能注册中心）返回的是同一份文件，不各写一份。
      try {
        return ok(readFileSync(resolve(root, USAGE_GUIDE), 'utf8'));
      } catch (e) {
        return err(
          `读不到使用指引（${USAGE_GUIDE}）：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    case 'list_judgments': {
      const limit = Number(args.limit ?? 20);
      let rows = w.store.listRecent(Number.isFinite(limit) ? limit : 20);

      const policyId = str(args, 'policyId');
      if (policyId) rows = rows.filter((r) => r.policyId === policyId);

      return ok(renderRows(rows));
    }

    case 'get_judgment': {
      const id = Number(args.judgmentId);
      if (!Number.isInteger(id)) return err('judgmentId 必须是整数');

      const rows = w.store.listRecent(1000);
      const row = rows.find((r) => r.id === id);
      if (!row) return err(`没有 id 为 ${id} 的判断记录`);

      const evidence = JSON.parse(row.evidenceJson) as { kind: string; detail: string; ref?: string }[];
      const lines = [
        `#${row.id} [${row.outcome}] ${row.policyId} @ ${row.policyVersion}`,
        `事件：${row.eventId}`,
        `时间：${row.createdAt}`,
        '',
        `结论：${row.reason ?? '（没有给出说明）'}`,
        '',
        '依据：',
        // 依据为空时要把这件事说出来，不能留一行「依据：」干在那儿 ——
        // 空白读起来与「没有依据」不是一个意思，而这一行正是给人看的。
        ...(evidence.length > 0
          ? evidence.map((e) => `- [${e.kind}] ${e.detail}${e.ref ? `（出处：${e.ref}）` : ''}`)
          : ['（无 —— 本次判定没有产生任何依据）']),
      ];

      // 用量单独一段。它回答的是「这次判断花了多少、有没有思考」——
      // 那是**随配置变**的事实，事后再去查环境变量读到的是"现在的配置"。
      const usageText = describeUsage(parseUsage(row.usageJson));
      if (usageText) lines.push('', `用量：${usageText}`);

      if (row.action) lines.push('', `动作：${row.action}（处置级别 ${row.actionLevel}）`);
      if (row.reaction) {
        lines.push('', `人的反应：${row.reaction}${row.reactionNote ? ` —— ${row.reactionNote}` : ''}`);
      }

      return ok(lines.join('\n'));
    }

    case 'policy_stats': {
      const lines = ['观察期统计（按策略版本切分）：', ''];

      for (const p of w.policies) {
        const rows = w.store.statsByPolicyVersion(p.id);

        if (rows.length === 0) {
          lines.push(`- ${p.id}（处置级别 ${p.disposal.level}）：还没有评估记录`, '');
          continue;
        }

        for (const s of rows) {
          lines.push(
            `- ${s.policyId} @ ${s.policyVersion}（当前处置级别 ${p.disposal.level}）`,
            `  评估 ${s.total} 次 · **看过 ${s.reviewed}** · 命中 ${s.hit} · 未命中 ${s.miss} · ` +
              `判断没做成 ${s.error} · 采纳 ${s.adopted} · 明确否定 ${s.rejected} · 无视 ${s.ignored}`,
          );

          // 「拦不住 / 没什么可拦 / 根本没开 / 从没真的判断过」四者必须分得开
          // —— 见 policy/health.ts。所以 error 也要传进去，不能只给 total 与 hit。
          const h = judgeHealth({
            enabled: p.enabled !== false,
            total: s.total,
            hit: s.hit,
            error: s.error,
          });
          if (h.health !== 'ok') lines.push(`  ⚠ ${h.note}`);
        }
        lines.push('');
      }

      lines.push(
        '注：按版本切分是因为判据改过之后命中率与之前不可比 —— 聚成一个数只会更好看。',
        '注：升级判据的分母是「看过」，不是「评估」—— 用评估当分母等于用冷漠稀释信号。',
        '注：只有「明确否定」进升级条件；「判断没做成」单独一列，不许并进未命中。',
      );
      return ok(lines.join('\n'));
    }

    case 'list_policies': {
      if (w.policies.length === 0) return ok('（平台没有装任何策略）');

      return ok(
        w.policies
          .map((p) => {
            const lines = [
              `- ${p.id} @ ${p.version}（动作 ${p.disposal.action} · 处置级别 ${p.disposal.level}）`,
              `  负责：${p.description}`,
            ];
            // 「不看什么」要一起给出来 —— 只看「负责什么」看不出两条策略重不重叠
            if (p.notFor) lines.push(`  不负责：${p.notFor}`);
            if (p.trigger) lines.push(`  触发条件：${JSON.stringify(p.trigger)}`);
            return lines.join('\n');
          })
          .join('\n'),
      );
    }

    case 'submit_change': {
      const project = str(args, 'project');
      const mrIid = Number(args.mrIid);
      const title = str(args, 'title');
      const changedFiles = args.changedFiles;

      if (!project) return err('缺少 project');
      if (!Number.isFinite(mrIid)) return err('缺少 mrIid（数字）');
      if (!title) return err('缺少 title');
      if (!Array.isArray(changedFiles)) return err('缺少 changedFiles（字符串数组）');

      const event = {
        id:
          str(args, 'eventId') ??
          `mcp-${project.replace(/[^\w]+/g, '-')}-${mrIid}-${Date.now()}`,
        source: 'mcp',
        // Agent 申报的变更带主张（title / description）与自编的 mrIid，形态上是 mr。
        // `as const` 是必须的：这里没有上下文类型，否则会被推成 string。
        kind: 'mr' as const,
        project,
        mrIid,
        title,
        description: str(args, 'description') ?? '',
        author: str(args, 'author') ?? 'unknown',
        targetBranch: str(args, 'targetBranch') ?? '',
        changedFiles: changedFiles.map(String),
        diff: str(args, 'diff'),
        occurredAt: str(args, 'occurredAt') ?? new Date().toISOString(),
      };

      const result = await runPipeline(event, {
        policies: w.policies,
        actions: w.actions,
        store: w.store,
        log: (m) => log(m),
      });

      return ok(renderPipelineResult(result));
    }

    case 'record_reaction': {
      const id = Number(args.judgmentId);
      const reaction = str(args, 'reaction');

      if (!Number.isInteger(id)) return err('judgmentId 必须是整数');
      if (reaction !== 'adopted' && reaction !== 'rejected' && reaction !== 'ignored') {
        return err('reaction 只能是 adopted / rejected / ignored');
      }

      const existing = w.store.listRecent(1000).find((r) => r.id === id);
      if (!existing) return err(`没有 id 为 ${id} 的判断记录`);

      w.store.setReaction(id, reaction, new Date().toISOString(), str(args, 'note'));
      return ok(
        `已记下第 ${id} 条判断的反应：${reaction}` +
          (reaction === 'rejected' ? '（这条会进升级条件）' : '（不进升级条件，但会留在记录里）'),
      );
    }

    default:
      return err(`未知工具：${name}`);
  }
}

// ── JSON-RPC 主循环 ─────────────────────────────────────

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id: number | string | null, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id: number | string | null, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(req: JsonRpcRequest): Promise<void> {
  const { id, method, params } = req;

  // 通知（没有 id）不需要响应 —— 回了反而会被对端当成多余的消息
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'collab-platform', version: '0.1.0' },
        });

      case 'ping':
        return reply(id, {});

      case 'tools/list':
        return reply(id, { tools: TOOLS });

      case 'tools/call': {
        const name = String(params?.name ?? '');
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        return reply(id, await callTool(name, args));
      }

      default:
        return fail(id, -32601, `未知方法：${method}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`工具调用出错：${message}`);
    return fail(id, -32000, message);
  }
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: JsonRpcRequest;
  try {
    req = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    // 整行不是 JSON 时没法回 —— 连 id 都读不出来。记到 stderr 就够了。
    log('收到无法解析的一行，已丢弃');
    return;
  }

  void handle(req);
});

rl.on('close', () => {
  w.store.close();
  process.exit(0);
});

log(
  `已启动 · 策略 ${w.policies.length} 条 · 模型 ${w.llmConfigured ? `${w.llm.name}/${w.llm.model}` : '未配置（第二条策略会落 error）'} · 库 ${dbPath}`,
);
