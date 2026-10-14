import { resolve } from 'node:path';
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
    client: new OpenAiCompatLlmClient({ baseUrl, apiKey, model }),
  };
}

export function wire(opts: WiringOptions): Wiring {
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
