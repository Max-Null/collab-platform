import { readFileSync } from 'node:fs';
import type { LlmClient } from '../llm/client.js';
import type { ChangeEvent, Evidence, ModelUsage, Policy, PolicyVerdict } from '../types.js';

/**
 * 判据配置（数据，不是代码）。
 *
 * 策略三段里的「判据」就是这两项：`instruction` 是自然语言，`gather` 是
 * **允许取哪些数**的白名单。人能改这里，不必改代码 ——
 * 判据会随团队经验不断调，把调判据变成改代码就没人愿意调了。
 */
export interface ClaimMismatchConfig {
  version: string;
  updatedAt?: string;
  note?: string;
  instruction: string;
  gather: string[];
}

export function loadClaimMismatchConfig(filePath: string): ClaimMismatchConfig {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as ClaimMismatchConfig;

  if (!parsed.version || typeof parsed.instruction !== 'string' || !Array.isArray(parsed.gather)) {
    throw new Error(`判据配置格式不对：${filePath}`);
  }
  return parsed;
}

/**
 * 客观来源。**只有这里列出的名字才能出现在 gather 白名单里。**
 *
 * 判据能取到什么，是这条策略的权限边界。加一项就是放宽一次，
 * 所以它是一份写死的注册表，而不是「事件里有什么就给什么」。
 */
const FACT_SOURCES: Record<string, (e: ChangeEvent) => string | undefined> = {
  changed_files: (e) => e.changedFiles.map((f) => `- ${f}`).join('\n'),
  diff: (e) => e.diff,
};

/**
 * 主张来源。**刻意不放进 FACT_SOURCES。**
 *
 * MR 标题和描述由提交者自己写，他能改的东西不是依据 —— 它只能是被检验的
 * 对象。所以这两项固定提供给判据（检验就得看得见主张），但永远不许出现在
 * gather 白名单里，配置里写了会在装配时直接报错。
 */
const CLAIM_SOURCES: Record<string, (e: ChangeEvent) => string> = {
  title: (e) => e.title,
  description: (e) => e.description,
};

const SYSTEM = `你在审查一次代码变更，判断改动内容与提交者声称要做的事是否对得上。

只报告下列情况之一：
- 改动范围与声称不符（例如声称"只改文案"，实际动了鉴权逻辑）
- 声称做了某项改动，代码里找不到
- 代码里改了声称完全没提的东西，且改动并非无关紧要

对不上就说出来，对得上就明确说没有。不要提风格、测试覆盖、命名这类与"声称是否属实"无关的意见。

如果你的结论**只在某种前提下成立**，把它写进 precondition —— 例如"仅在描述写得过于简略时成立"。
没有前提就留空串。**不要为了显得严谨而编一个前提**：有条件的结论和不带条件的结论，
人对待它们的方式不同，编出来的前提会让人无法判断该不该信这条。

只输出 JSON，不要别的话：
{"mismatch": true 或 false, "reason": "一句话结论", "precondition": "结论成立的前提，没有就空串", "items": ["具体不符之处", "..."]}`;

/** 模型偶尔会把 JSON 包在代码块里，剥掉再解析；解析不出来就返回 null，由调用方当「没做成」 */
function parseVerdict(text: string): {
  mismatch: boolean;
  reason: string;
  precondition?: string;
  items: string[];
} | null {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;

  const d = data as Record<string, unknown>;
  if (typeof d.mismatch !== 'boolean') return null;

  // 空串等于没有前提 —— 别把「模型给了个空字段」显示成人话里的空白
  const pre = typeof d.precondition === 'string' ? d.precondition.trim() : '';

  return {
    mismatch: d.mismatch,
    reason: typeof d.reason === 'string' ? d.reason : '',
    precondition: pre || undefined,
    items: Array.isArray(d.items) ? d.items.filter((x): x is string => typeof x === 'string') : [],
  };
}

/**
 * 策略：改动与声称不符。
 *
 * 与敏感路径那条不同，这条**依赖模型判断**，因此它会误报 ——
 * 所以它的处置从一级起步、进观察期（见设计第 4 条②⑥）：
 * 先只说、不拦，攒够「命中后到底对不对」的数据再谈升级。
 */
export function createClaimMismatchPolicy(config: ClaimMismatchConfig, llm: LlmClient): Policy {
  // 装配时就校验白名单，而不是等运行时静默取不到数。
  // 「评估失败不等于通过」这条判据，用在这里比用在任何地方都值：
  // 一条取不到数的策略会永远「没命中」，看起来与"系统很干净"一模一样。
  for (const name of config.gather) {
    if (name in CLAIM_SOURCES) {
      throw new Error(
        `策略 review-claim-mismatch 的 gather 白名单里出现了「${name}」—— ` +
          `它由提交者自己写、随时可以改，属于主张而不是依据。` +
          `依据只能取：${Object.keys(FACT_SOURCES).join(' / ')}`,
      );
    }
    if (!(name in FACT_SOURCES)) {
      throw new Error(
        `策略 review-claim-mismatch 的 gather 白名单里有未知来源「${name}」，` +
          `可用的只有：${Object.keys(FACT_SOURCES).join(' / ')}`,
      );
    }
  }

  const policyId = 'review-claim-mismatch';

  return {
    id: policyId,
    version: config.version,
    description: '改动内容与 MR 声称要做的事不匹配时提示复核',

    notFor: '不判断路径安全、凭据暴露、配置越权 —— 那些靠路径与规则匹配，不需要模型',

    // 不设触发条件，**这是刻意的**：拿不到 diff 是「取数失败」而不是
    // 「这条策略不关心这类事件」—— 前者要落 error 让人看见，后者才静默跳过。
    // 若在这里用 trigger 把没有 diff 的事件挡掉，就等于把「本该跑但没跑成」
    // 降级成「不关我的事」。见 types.ts 的 PolicyTrigger。

    // 观察期从一级开始：只说，不拦
    disposal: { action: 'comment', level: 1 },

    async evaluate(event: ChangeEvent): Promise<PolicyVerdict> {
      const base = { policyId, policyVersion: config.version };

      // —— 取数：只从白名单取；取不到就不判断 ——
      //
      // 「取不到」与「取到了但是空的」必须分开报：前者是接口或字段出了问题，
      // 后者是这个 MR 真的没有改动。两种都不该做判断，但事后看记录的人
      // 需要一眼分清当时是哪种 —— 混成一句话，排查就得从头再跑一遍。
      const facts: Record<string, string> = {};
      const missing: string[] = [];
      const empty: string[] = [];

      for (const name of config.gather) {
        const value = FACT_SOURCES[name]!(event);
        if (value === undefined) missing.push(name);
        else if (value.trim() === '') empty.push(name);
        else facts[name] = value;
      }

      if (missing.length > 0 || empty.length > 0) {
        const why =
          missing.length > 0
            ? `取不到来源 ${missing.join(' / ')}`
            : `来源 ${empty.join(' / ')} 取到了但是空的（这次变更没有任何改动）`;

        return {
          ...base,
          outcome: 'error',
          reason: `${why}，本次没有做判断（不以「没数据」冒充「没问题」）`,
          evidence: [
            ...missing.map((m) => ({
              kind: 'gather' as const,
              detail: `取不到来源：${m}`,
              ref: m,
            })),
            ...empty.map((m) => ({
              kind: 'gather' as const,
              detail: `来源为空：${m}`,
              ref: m,
            })),
          ],
        };
      }

      const claims = Object.fromEntries(
        Object.entries(CLAIM_SOURCES).map(([key, pick]) => [key, pick(event)]),
      );

      const prompt = [
        config.instruction,
        '',
        '【声称】（提交者自述，仅供检验，不作为事实依据）',
        `标题：${claims.title || '（空）'}`,
        `描述：${claims.description || '（空）'}`,
        '',
        '【实际改动】（客观事实）',
        '文件：',
        facts.changed_files!,
        '',
        'diff：',
        '```diff',
        facts.diff ?? '（无 diff）',
        '```',
      ].join('\n');

      let text: string;
      // 用量跟着这次判定一起走。记录里得答得出「这次判断花了多少、有没有思考」，
      // 而那两个答案是**随配置变**的 —— 事后再去查环境变量，读到的是"现在的配置"。
      let usage: ModelUsage | undefined;
      try {
        const response = await llm.complete({ system: SYSTEM, prompt, json: true });
        text = response.text;
        usage = response.usage;
      } catch (err) {
        return {
          ...base,
          outcome: 'error',
          reason: `模型调用失败，本次没有做判断：${(err as Error).message}`,
          evidence: [{ kind: 'model', detail: `${llm.name} / ${llm.model}`, ref: llm.model }],
        };
      }

      const parsed = parseVerdict(text);
      if (!parsed) {
        return {
          ...base,
          outcome: 'error',
          reason: '模型返回的不是约定的 JSON，本次没有做判断',
          // 模型确实被调用了、也确实花了 token —— 所以用量要带上
          modelUsage: usage,
          evidence: [
            { kind: 'model', detail: `${llm.name} / ${llm.model}`, ref: llm.model },
            { kind: 'model', detail: `原始返回：${text.slice(0, 300)}`, ref: 'raw_model_text' },
          ],
        };
      }

      const evidence: Evidence[] = [
        {
          kind: 'gather',
          detail: `本次取数：${config.gather.join(' / ')}`,
          ref: config.gather.join(','),
        },
        { kind: 'model', detail: `判断模型：${llm.name} / ${llm.model}`, ref: llm.model },
        ...parsed.items.map((item) => ({ kind: 'rule' as const, detail: item })),
      ];

      return {
        ...base,
        outcome: parsed.mismatch ? 'hit' : 'miss',
        reason: parsed.reason || undefined,
        // 「只在描述过于简略时成立」这类限定要一起带出去 —— 丢掉它，
        // 一条条件结论就变成了无条件结论，而人对着它只能答「对/不对」
        precondition: parsed.precondition,
        evidence,
        modelUsage: usage,
      };
    },
  };
}
