/**
 * 策略的健康信号。
 *
 * 三种「看起来一样」的情况必须分得开 —— 它们的现象都是「没有命中记录」，
 * 而处置完全不同：
 *
 * | 情况 | 现象 | 该做什么 |
 * |---|---|---|
 * | **根本没开** | 停用，零记录 | 要么打开，要么删掉。挂着的停用策略只会让人以为它在工作 |
 * | **没什么可拦** | 跑得还少 | 等。现在下结论等于拿噪声当证据 |
 * | **拦不住** | 跑了很久、一次没命中 | 问一句：是判据太窄，还是这类变更根本不存在？|
 *
 * 这正是那条判据的落点：**一个标签如果可能对应两种截然不同的现实，
 * 它就不是个合格的探针。**
 */

/**
 * 跑够多少次还没命中过，才值得问一句。
 *
 * ⚠️ **这个数是拍的，不是算出来的。** 真要让它有依据，得等观察期攒出
 * 数据、知道这条策略正常情况下的命中率是多少（那是待办 T2）。
 * 在那之前，它只用来**提示** —— 不触发任何动作、不进任何统计的分母。
 * 拍一个比不拍好：不拍的话，「拦不住」和「没什么可拦」永远长得一样。
 */
export const NEVER_HIT_THRESHOLD = 20;

export type PolicyHealth = 'off' | 'tooFewRuns' | 'neverHit' | 'ok';

export interface HealthJudgment {
  health: PolicyHealth;
  /** 人话说明。`ok` 时为空 */
  note: string;
}

export function judgeHealth(input: {
  enabled: boolean;
  total: number;
  hit: number;
}): HealthJudgment {
  if (!input.enabled) {
    return {
      health: 'off',
      note: '已停用 —— 它一条记录都不会有，而这看起来和「没什么可拦」一样',
    };
  }

  if (input.total < NEVER_HIT_THRESHOLD) {
    return {
      health: 'tooFewRuns',
      note:
        input.total === 0
          ? '还没有评估记录'
          : `只评估过 ${input.total} 次（不到 ${NEVER_HIT_THRESHOLD}）—— 现在看不出它拦不拦得住`,
    };
  }

  if (input.hit === 0) {
    return {
      health: 'neverHit',
      note:
        `评估 ${input.total} 次、一次没命中 —— ` +
        '要问的是：判据太窄，还是这类变更根本不存在？（两种情况的处置完全不同）',
    };
  }

  return { health: 'ok', note: '' };
}
