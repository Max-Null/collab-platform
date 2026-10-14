/**
 * 平台的核心类型定义。
 *
 * 当前只实现「提交进入主干前的审查」这一条链路，
 * 因此类型围绕四段：一次变更事件 → 策略判定 → 动作 → 判断记录。
 */

/** 一次变更事件。第一版只支持 MR（合并请求），事件源可插拔。 */
export interface ChangeEvent {
  /** 事件唯一标识，判断记录靠它关联回事件 */
  id: string;
  /** 事件来源：'mock' | 'gitlab' */
  source: string;
  /** 项目标识（第一版只用于记录，不做隔离） */
  project: string;
  /** MR 编号 */
  mrIid: number;
  title: string;
  description: string;
  author: string;
  /** 目标分支（第一版只用于记录） */
  targetBranch: string;
  /** 本次变更涉及的文件路径，仓库根相对 */
  changedFiles: string[];
  /**
   * 变更的 diff 文本。
   *
   * mock 事件里直接给出；真实 GitLab 的 webhook payload **不含 diff**，
   * 由取数环节另调 API 补上。它是客观事实，进 gather 白名单。
   */
  diff?: string;
  /** 事件发生时间，ISO 8601 */
  occurredAt: string;
}

/** 一条依据。判断记录里的 evidence 就是它的数组 —— 这是「判断必须带依据」的落点。 */
export interface Evidence {
  /**
   * 依据的种类。区分它们是有用的：只有 `changed_file` 是查得到的客观事实，
   * `rule` 是策略本身，`gather` 说明取到了哪些数，`model` 说明是哪家模型下的判断。
   * 事后追责时，「这条结论从哪儿来」要答得出来。
   */
  kind: 'changed_file' | 'rule' | 'gather' | 'model';
  /** 人可读的明细 —— 写在评论里给人看的那句话 */
  detail: string;
  /**
   * 这条依据的**机器可读锚点**：`changed_file` 放**文件路径**，`rule` 放规则表达式，
   * `gather` 放取数项，`model` 放模型名。
   *
   * ⚠️ `changed_file` 的 `ref` 必须是**文件路径**，不能是 glob。因为不同策略之间
   * 要靠它比对「是不是指向同一处」（见 `RecordStore.corroborationOf`）——
   * 那是平台唯一一种**零人力成本**的置信度来源。而 glob 只说明"按什么规则挑出来的"，
   * 两条不同规则的 glob 永远对不上，那样比对出来的永远是「没有旁证」。
   */
  ref?: string;
}

/**
 * 判定的结局。
 *
 * 三态而不是布尔：「命中 / 没命中」漏掉了第三态 —— **判断没做成**。
 * 把「没做成」并进「没命中」，就等于用失败冒充通过，
 * 而失败恰恰是最需要人看见的那一种（模型调不通、事件的 diff 取不到…）。
 */
export type VerdictOutcome = 'hit' | 'miss' | 'error';

/** 策略判定结果 */
export interface PolicyVerdict {
  policyId: string;
  policyVersion: string;
  /** 判定结局 */
  outcome: VerdictOutcome;
  /** 命中、或判断没做成时的说明，直接给人看 */
  reason?: string;
  /**
   * 这个结论**在什么前提下成立**。
   *
   * ⚠️ 注意它**不是第四种结局**。判定的三态（命中 / 未命中 / 判断没做成）
   * 说的是「这次判定怎么了」；而「条件成立」说的是「这个结论本身有多少限定」。
   * 一条**有条件才成立的命中仍然是命中** —— 它只是不该被当成无条件的。
   *
   * **为什么这个字段非有不可**：一条无条件的 `hit` 会进人的待办、会被要求
   * 表态、会算进否定率 —— 而人只能就「对 / 不对」表态，**前提没有地方放**。
   * 于是那个表态对一条条件结论来说是没有意义的：人否定的可能是那个前提，
   * 却被记成了「这条判断错了」。
   *
   * 例：判「改动与声称不符」，但**只在描述写得过于简略时成立**。
   */
  precondition?: string;
  /** 支撑这条判定的依据 */
  evidence: Evidence[];
}

/** 处置级别：1 自主 · 2 留痕 · 3 待人确认 */
export type DisposalLevel = 1 | 2 | 3;

/** 处置：命中之后该做什么 */
export interface Disposal {
  action: 'comment' | 'create_task' | 'hold_merge';
  level: DisposalLevel;
}

/**
 * 策略的触发条件（结构化）。
 *
 * **为什么需要它**：管道原本对**每个事件跑每一条策略**。两条策略时无所谓，
 * 十条策略时成本就是「策略数 × 事件数」—— 而且其中大量事件根本不在那条
 * 策略的覆盖范围内（一条管凭据文件的策略，不该去判一次纯文案改动）。
 *
 * ⚠️ **触发不通过与取数失败是两件事，必须分开**：
 * - `trigger` 不通过 → **静默跳过**。这是正常的：策略本来就不关心这类事件
 * - `trigger` 通过但 `gather` 取不到 → **落 `error`**。这是异常，要人看见
 *
 * 把后者当成前者，就等于「本该跑的策略悄悄没跑」—— 而这个平台的存在理由
 * 就是不让这种事情悄悄发生。
 */
export interface PolicyTrigger {
  /** 只在这些路径模式下触发（glob）。缺省 = 任何路径都触发 */
  pathGlobs?: string[];
  /** 目标分支匹配时才触发。缺省 = 任何分支 */
  targetBranch?: string;
  /** 改动文件数达到这个数才触发。缺省 = 不设门槛 */
  minChangedFiles?: number;
  /** 事件来源（'mock' | 'gitlab' | 'mcp'…）。缺省 = 任何来源 */
  sources?: string[];
}

/**
 * 策略。
 *
 * 完整的三段是**触发 / 判据 / 处置** —— 这一版三段齐了：
 * `trigger`（对什么事件感兴趣）· `evaluate`（怎么判）· `disposal`（判完做什么）。
 */
export interface Policy {
  id: string;
  version: string;
  /** 人可读的策略说明 —— **它负责判断什么** */
  description: string;
  /**
   * **它不负责判断什么。**
   *
   * 「不看什么」比「看什么」更能防职责重叠 —— 两条策略的 `description`
   * 各说各话时看不出重叠，而两条 `notFor` 撞在一起时一眼就看出。
   */
  notFor?: string;
  /** 触发条件。缺省 = 对所有事件触发 */
  trigger?: PolicyTrigger;
  /**
   * 这条策略是不是启用的。缺省 = 启用。
   *
   * ⚠️ **「停用」与「没命中」是两件长得一样的事**：前者是「根本没开」，
   * 后者是「开了，但这次没问题」。两者的统计都是 0 条命中记录 ——
   * 而它们对「该不该调整这条策略」的含义完全相反。
   *
   * 所以停用的策略**仍然留在列表里**（而不是从装配里过滤掉），
   * 只是管道会跳过它、统计会标出来。过滤掉就等于让"根本没开"消失。
   *
   * 这也是「一个标签若能对应两种截然不同的现实，它就不是合格的探针」
   * 那条判据在策略上的落点：`off` 这一态必须能被表达。
   */
  enabled?: boolean;
  /** 当前生效的处置。观察期升级时改这里，并留痕。 */
  disposal: Disposal;
  /**
   * 返回 Promise：LLM 判据是异步的，纯规则策略写 `async` 后直接 return 即可。
   * 统一成异步是为了让两类策略在管道里长得一样 —— 管道不必知道谁在背后调模型。
   */
  evaluate(event: ChangeEvent): Promise<PolicyVerdict>;
}

/** 动作执行结果 */
export interface ActionResult {
  action: string;
  ok: boolean;
  /** 实际产生的输出（评论正文等），便于回看与测试断言 */
  output?: string;
  error?: string;
  /**
   * 外部系统里的引用（如 GitLab 的 note id）。
   *
   * **回滚要靠它。** 发出去的评论收不回来，除非记下了收哪一条。
   * 这是「退出 / 幂等 / 回滚」三条件里唯一一处平台原本空缺的地方 ——
   * 而它只在写开关打开之后才成为真问题，所以更该在那之前就位。
   */
  externalRef?: string;
  /**
   * 动作**做成了**，但它想表达的意思没有完全达成。
   *
   * 例：`hold_merge` 成功发了一条"不批准"评论、也打了挂起标记 ——
   * 可如果那个仓库的 Allowed to merge 还是 Maintainers，
   * **任何 maintainer 都能直接合掉**，「拦」这件事就没发生。
   *
   * 这个字段存在的理由：**不做成 `ok: false`**（动作确实执行了，说失败是撒谎），
   * 也**不能默默通过**（那就变成了新的静默失效）。它必须被看见。
   */
  warning?: string;
}

/** 人的反应 —— 对应观察期采集字段的第三类，事后补填 */
export type Reaction = 'adopted' | 'rejected' | 'ignored';

/**
 * 一条判断记录。平台最核心的留痕。
 *
 * 字段对齐调研给出的审计七元组：
 * agent 身份 · 问责主体 · 授权上下文 · 请求标识 · 时间戳 · 策略约束 · 结果状态
 * 本版先落其中可直接得到的部分；身份与授权上下文等接入真实 Actor 模型后再补。
 */
export interface JudgmentRecord {
  id?: number;
  /** 请求标识：事件 id */
  eventId: string;
  /** 策略约束：哪条策略、哪个版本 */
  policyId: string;
  policyVersion: string;
  /** 结果状态 */
  outcome: VerdictOutcome;
  /** 结论：命中的说明、或判断没做成的说明 */
  reason?: string;
  /** 这个结论成立的前提（有的话）。见 PolicyVerdict.precondition */
  precondition?: string;
  /** 依据：evidence 的 JSON 序列化 */
  evidenceJson: string;
  /** 实际执行的动作与级别 */
  action?: string;
  actionLevel?: number;
  /** 外部系统里的引用（如 GitLab note id）—— 回滚靠它找到那条评论 */
  externalRef?: string;
  /** 什么时候被撤销的。有值就说明这条动作已经被收回 */
  undoneAt?: string;
  /**
   * 这次判定是生效版还是影子版（草稿判据跑出来的）。
   *
   * 影子判定**不进观察期统计的分母**：否则分母凭空翻倍，而且混进了
   * 「从来没被人看见过」的命中 —— 那些命中没有人回写反应，按观察期的算法
   * 会被算成「无视」，于是真实信号被稀释，而数据看起来只是变多了。
   */
  origin: JudgmentOrigin;
  /** 时间戳 */
  createdAt: string;
  /** 人的反应（事后由人填，观察期靠它判断该不该升级） */
  reaction?: Reaction;
  /** 为什么这么反应 —— 判据要靠它改进，所以它进库而不只是进终端 */
  reactionNote?: string;
  reactedAt?: string;
}

/** 一条判断的来源。影子判定不进观察期统计（见设计 §3.8）。 */
export type JudgmentOrigin = 'effective' | 'shadow';

/**
 * 一条策略的观察期统计。
 *
 * **按策略版本切分，不按策略 id 聚合。** 判据改过之后，命中率与之前根本不可比；
 * 处置级别从 1 到 2，命中之后发生的事也完全是两回事。按 id 聚合会得到一个把
 * 两种不同东西平均在一起的数 —— 而这个数看起来更平滑、更像「长期趋势」，
 * 于是更容易被信任。
 */
export interface PolicyVersionStats {
  policyId: string;
  policyVersion: string;
  /** 被评估的次数 —— 这是「跑过没有」的分母，不是升级判据的分母 */
  total: number;
  /**
   * 其中**被人看过**的次数（有人回写过反应）。
   *
   * ⚠️ 这是升级判据该用的分母。用 `total` 当分母等于**用冷漠稀释信号** ——
   * 一条策略跑了 100 次、99 次没人理，唯一那次被人明确否定的判断，
   * 在「1/100」里看起来像噪声，在「1/1」里才看得出是真被推翻过。
   * 这跟「判断没做成并进未命中」是同一类错误，只是换了个位置。
   */
  reviewed: number;
  hit: number;
  miss: number;
  /** 判断没做成的次数 —— 必须单独可见，不能混进 miss */
  error: number;
  adopted: number;
  rejected: number;
  ignored: number;
}

/** 管道的执行结果 */
export interface PipelineResult {
  event: ChangeEvent;
  /** 每条策略的评估结果 —— 含未命中的，否则无从知道「看过但没问题」 */
  verdicts: PolicyVerdict[];
  /** 命中后实际执行的动作 */
  actions: ActionResult[];
  /** 落库的判断记录条数 */
  recorded: number;
  /**
   * 因**触发条件不通过**而跳过的策略（不是评估过、也不是评估失败）。
   *
   * 与「未命中的评估」分开，也**不落库** —— 它不代表任何判断。
   * 但它要能报出来：否则一条策略长期不触发时，没人分得清是
   * 「它没用」还是「它的触发条件写窄了」。
   */
  skippedByTrigger: { policyId: string; reason: string }[];
}
