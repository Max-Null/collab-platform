import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CommentAction } from './action/commenter.js';
import type { ActionRunner } from './action/commenter.js';
import { GitLabCommentAction } from './action/gitlab-comment.js';
import { GitLabHoldMergeAction } from './action/hold-merge.js';
import type { GitLabApi } from './gitlab/api.js';
import type { LlmClient } from './llm/client.js';
import { OpenAiCompatLlmClient } from './llm/openai-compat.js';
import { StubLlmClient } from './llm/stub.js';
import { createClaimMismatchPolicy, loadClaimMismatchConfig } from './policy/claim-mismatch.js';
import { createSensitivePathPolicy, loadSensitivePathConfig } from './policy/sensitive-path.js';
import { RecordStore } from './record/store.js';
import type { Policy } from './types.js';

/**
 * 装配。
 *
 * CLI 与 MCP 出口共用这一段：**平台跑出什么结论，不该取决于你是从哪儿进来的**。
 * 两边各装配一遍，迟早会在某一条策略或某一个开关上不一致，
 * 而那种不一致最难发现 —— 从两个入口看同一个仓库，得到两种答案。
 */

export interface GitLabWiring {
  api: GitLabApi;
  project: string;
  /**
   * 写开关，默认关。关着时正文照常渲染并落到 outDir，只是不发出去 ——
   * 干燥跑走的是与真发同一条代码路径，落盘的就是会发出去的那份文本。
   */
  write: boolean;
}

export interface WiringOptions {
  root: string;
  dbPath: string;
  outDir: string;
  gitlab?: GitLabWiring;
}

export interface Wiring {
  policies: Policy[];
  actions: Map<string, ActionRunner>;
  store: RecordStore;
  llm: LlmClient;
  /** 是否真的配了模型。没配时第二条策略会落 error，而不是假装通过。 */
  llmConfigured: boolean;
}

/**
 * 模型装配。
 *
 * 没配 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 时**不假装判断过了** ——
 * 桩直接抛错，让判据落一条 error 记录。空跑出「全部未命中」比什么都不跑更坏：
 * 它长得跟「系统很干净」一模一样，而实际上没有任何人看过。
 */
/**
 * 读一个可选的数字配置。
 *
 * 配错了**在装配期报错**，不静默回落到默认 —— 与平台其它地方一致（白名单里出现
 * 未知来源同样是装配期抛错，而不是运行时静默取空）。回落的表现是「配置写了但
 * 没生效」，那与「没写」长得一模一样。
 */
function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} 不是数字：${raw}`);
  return value;
}

/** 读一个可选的 JSON 对象配置。同样在装配期报错，不静默忽略。 */
function optionalJsonObject(name: string): Record<string, unknown> | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${name} 必须是一个 JSON 对象，例如 {"thinking":{"type":"disabled"}}`);
  }
  return parsed as Record<string, unknown>;
}

export function createLlm(): { client: LlmClient; configured: boolean } {
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;

  if (!baseUrl || !apiKey || !model) {
    return {
      configured: false,
      client: new StubLlmClient(() => {
        throw new Error(
          '未配置模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL），本次没有真的做判断',
        );
      }),
    };
  }

  return {
    configured: true,
    client: new OpenAiCompatLlmClient({
      baseUrl,
      apiKey,
      model,
      // 三个可选项。
      //
      // `temperature` 默认 0（判据要的是可复现），但**支持思考模式的厂商会忽略它**
      // —— 见 openai-compat.ts 里那段注释。厂商特有的思考参数走 LLM_EXTRA_BODY
      // 透传，例如 DeepSeek 的 {"thinking":{"type":"disabled"}}。
      temperature: optionalNumber('LLM_TEMPERATURE'),
      timeoutMs: optionalNumber('LLM_TIMEOUT_MS'),
      extraBody: optionalJsonObject('LLM_EXTRA_BODY'),
    }),
  };
}

export function wire(opts: WiringOptions): Wiring {
  // 库与输出的目录要先存在。
  //
  // SQLite **不会**替你建父目录，而干净检出里 `var/` 根本不存在（它被 .gitignore 忽略）——
  // 于是第一次跑 `npm run demo` 崩在「unable to open database file」：那句话读起来
  // 像库文件坏了，其实是目录不存在。动作落文件的目录同理。
  //
  // 修在装配层而不是 RecordStore 里：CLI 与 MCP 两个入口共用这一段（见文件抬头），
  // 修在 store 里只覆盖其中一个入口，另一个照样崩。
  if (opts.dbPath !== ':memory:') mkdirSync(dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.outDir, { recursive: true });

  const pathConfig = loadSensitivePathConfig(
    resolve(opts.root, process.env.SENSITIVE_PATH_CONFIG ?? 'config/sensitive-paths.json'),
  );
  const judgeConfig = loadClaimMismatchConfig(
    resolve(opts.root, process.env.CLAIM_MISMATCH_CONFIG ?? 'config/claim-mismatch.json'),
  );

  const { client: llm, configured: llmConfigured } = createLlm();

  const policies: Policy[] = [
    createSensitivePathPolicy(pathConfig),
    createClaimMismatchPolicy(judgeConfig, llm),
  ];

  const actions = new Map<string, ActionRunner>();

  if (opts.gitlab) {
    actions.set(
      'comment',
      new GitLabCommentAction({
        api: opts.gitlab.api,
        project: opts.gitlab.project,
        write: opts.gitlab.write,
        outDir: opts.outDir,
      }),
    );

    // `hold_merge`（级别 3）也一起注册。
    //
    // ⚠️ **现在没有任何策略声明它** —— 现有两条都在级别 1。这**不是遗留的死代码**，
    // 而是「观察期升级」这条设计的落点：判据攒够数据、人决定升级时，
    // 改的是策略的 `disposal`，动作这一侧不该再动代码。
    // 「加一条策略、升一个级别都该是纯新增/纯配置」——这是 §四 那条架构原则。
    actions.set(
      'hold_merge',
      new GitLabHoldMergeAction({
        api: opts.gitlab.api,
        project: opts.gitlab.project,
        write: opts.gitlab.write,
        outDir: opts.outDir,
      }),
    );
  } else {
    // 没有 GitLab 时用本地动作 —— 但**没有本地版的 hold_merge**：
    // 「挂起合并」在本地无从表达，硬造一个假的会更坏（它会看起来成功）。
    // 所以那种组合下，级别 3 的策略会走到「平台没有它的实现」那条分支并如实报出来。
    actions.set('comment', new CommentAction(opts.outDir));
  }

  return {
    policies,
    actions,
    store: new RecordStore(opts.dbPath),
    llm,
    llmConfigured,
  };
}
