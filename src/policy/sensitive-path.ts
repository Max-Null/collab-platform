import { readFileSync } from 'node:fs';
import type { ChangeEvent, Evidence, Policy, PolicyVerdict } from '../types.js';
import { globToRegExp } from './glob.js';

/** 一条敏感路径规则 */
export interface SensitivePathRule {
  glob: string;
  label: string;
}

/** 敏感路径清单（数据，不是代码） */
export interface SensitivePathConfig {
  version: string;
  updatedAt: string;
  note?: string;
  paths: SensitivePathRule[];
}

export function loadSensitivePathConfig(filePath: string): SensitivePathConfig {
  const raw = readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as SensitivePathConfig;

  if (!parsed.version || !Array.isArray(parsed.paths)) {
    throw new Error(`敏感路径配置格式不对：${filePath}`);
  }
  return parsed;
}

/**
 * 策略：敏感路径变更。
 *
 * 这是一条**纯规则**策略 —— 不调用任何模型。路径匹配是客观的，
 * 因此它不存在误报，也就不需要观察期（见设计第 4 条②）。
 * 它的价值不在「判断」，在于它能让整条链路立刻跑起来。
 */
export function createSensitivePathPolicy(config: SensitivePathConfig): Policy {
  const compiled = config.paths.map((rule) => ({
    ...rule,
    re: globToRegExp(rule.glob),
  }));

  return {
    id: 'review-sensitive-path',
    version: config.version,
    description:
      '变更触及敏感路径（鉴权 / 配置 / 库表 / CI / 团队规则 / 凭据）时提示复核',

    // 「不看什么」比「看什么」更能防职责重叠 —— 两条策略的 description
    // 各说各话时看不出重叠，两条 notFor 撞在一起时一眼就看出。
    notFor: '不判断「改动与它声称要做的事是否相符」—— 那要读 diff 与描述，归语义类策略',

    // 不设触发条件：任何变更都可能碰到敏感路径，这一点不需要分流。
    // （trigger 是给"只关心某类变更"的策略用的，见 types.ts 的 PolicyTrigger。）

    // 观察期从一级开始：只说，不拦。
    // 升级到「挂起合并」由人看着数据决定（见设计第 4 条⑥）。
    disposal: { action: 'comment', level: 1 },

    async evaluate(event: ChangeEvent): Promise<PolicyVerdict> {
      const evidence: Evidence[] = [];

      for (const file of event.changedFiles) {
        for (const rule of compiled) {
          if (rule.re.test(file)) {
            evidence.push({
              kind: 'changed_file',
              // ref 放**文件路径**、detail 放人话：别的策略要靠 ref 比对
              // 「是不是指向同一处」，glob 做不到这件事（见 types.ts 的 Evidence）
              ref: file,
              detail: `${rule.label}（按规则 ${rule.glob} 命中）`,
            });
            break; // 一个文件最多记一条依据，避免同一文件命中多条相似规则时刷屏
          }
        }
      }

      const hit = evidence.length > 0;
      return {
        policyId: this.id,
        policyVersion: this.version,
        outcome: hit ? 'hit' : 'miss',
        // miss 也要给结论。少了这句，记录从 MCP / 控制台读回来就是
        // 「（没有给出说明）」加一段空依据 —— 那与「平台没跑过」难以区分，
        // 而 README 的约束是「每次判定都表态，包括什么都没发现的时候」。
        // CLI 打印的「未命中（看过，没问题）」属于显示层，不该是唯一的出处。
        reason: hit
          ? `本次变更的 ${event.changedFiles.length} 个文件中有 ${evidence.length} 个触及敏感路径`
          : `本次变更的 ${event.changedFiles.length} 个文件都没有触及敏感路径`,
        evidence,
      };
    },
  };
}
