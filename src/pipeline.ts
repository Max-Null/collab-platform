import type { ActionRunner } from './action/commenter.js';
import { checkTrigger } from './policy/trigger.js';
import type { RecordStore } from './record/store.js';
import type {
  ActionResult,
  ChangeEvent,
  PipelineResult,
  Policy,
  PolicyVerdict,
} from './types.js';

export interface PipelineDeps {
  policies: Policy[];
  actions: Map<string, ActionRunner>;
  store: RecordStore;
  /** 注入时钟，便于测试断言 */
  now?: () => Date;
  log?: (msg: string) => void;
}

/**
 * 把四段串起来：策略判定 → 动作 → 判断记录。
 *
 * （第一段是事件，由调用方送进来。）
 *
 * 三个刻意的设计：
 * ① **未命中也要落记录** —— 否则事后无从知道「看过但没问题」，
 *    而观察期要统计的分母正是「策略被评估了多少次」。
 * ② **动作缺失要显式暴露** —— 策略声明了某个动作而平台没实现时，
 *    必须说出来，不能静默跳过。这跟「评估失败不等于通过」是同一条判据。
 * ③ **先跑完所有策略，再动一次手** —— 边判边动会让同一次变更在 MR 上
 *    留下好几条评论。评论噪音的代价是被人静音，而静音之后这套机制
 *    就等于不存在了；GM 的价值恰恰是替人省下 review 的精力。
 */
export async function runPipeline(
  event: ChangeEvent,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});

  const verdicts: PolicyVerdict[] = [];
  const actions: ActionResult[] = [];
  const skippedByTrigger: { policyId: string; reason: string }[] = [];
  let recorded = 0;

  for (const policy of deps.policies) {
    // 停用的策略：跳过，但**留在列表里**。过滤掉就等于让「根本没开」消失 ——
    // 而它与「开了但没命中」的统计长得一样（都是 0），却要做完全不同的处置。
    if (policy.enabled === false) {
      skippedByTrigger.push({ policyId: policy.id, reason: '策略已停用' });
      continue;
    }

    // 触发先于取数：这条策略对这个事件不感兴趣，就**静默跳过**。
    // ⚠️ 与「取数失败」是两件事 —— 后者落 error、要人看见（见 types.ts 的 PolicyTrigger）。
    // 把取数失败也当成"不关心"，就等于本该跑的策略悄悄没跑。
    const decision = checkTrigger(policy.trigger, event);
    if (!decision.matched) {
      skippedByTrigger.push({ policyId: policy.id, reason: decision.reason ?? '触发条件不通过' });
      continue;
    }

    // 同一条事件、同一条策略、同一个版本，只判一次。轮询会反复拉到同一个 MR，
    // 重复落记录会让观察期的分母凭空变大，而且看不出来 —— 数据只是「更多了」。
    // 逐策略判断而不是整体跳过：策略是各自独立演进、独立观察的。
    //
    // 跳过**不打日志**：那是正常流程不是异常，而长跑的轮询每轮都会撞上一批
    // （20 条 MR × 2 条策略就是 40 行），把真正该看的行淹掉。
    // 需要知道跳过了多少，由调用方自己数 —— daemon 就是那么做的。
    if (deps.store.hasJudged(event.id, policy.id, policy.version)) {
      continue;
    }

    verdicts.push(await policy.evaluate(event));
  }

  // 用哪个动作、哪个级别：取级别最高的那条策略，**不管它这次有没有命中** ——  // 因为「什么都没发现」也要说一句（见 renderComment），而那句话同样是一次动作。
  // 一条要求挂起、另一条只提示，整体按挂起算：处置只会取严，不会取松。
  const lead = deps.policies.reduce<Policy | undefined>(
    (a, b) => (a === undefined || b.disposal.level > a.disposal.level ? b : a),
    undefined,
  );

  let actedPolicyId: string | undefined;
  let actedExternalRef: string | undefined;

  if (lead) {
    const runner = deps.actions.get(lead.disposal.action);

    if (!runner) {
      log(
        `⚠️ 策略 ${lead.id} 声明了动作「${lead.disposal.action}」，但平台没有它的实现 —— 这次命中没有被处置`,
      );
    } else {
      const result = await runner.run({ event, verdicts }, lead.disposal.level);
      actions.push(result);
      actedPolicyId = lead.id;
      // 外部引用（如 GitLab note id）要落库 —— 它是回滚唯一的线索
      actedExternalRef = result.externalRef;

      if (!result.ok) {
        log(`⚠️ 动作 ${result.action} 执行失败：${result.error ?? '未知原因'}`);
      } else if (result.warning) {
        // 做成了，但意思没达成 —— 必须说出来，否则就是新的静默失效
        log(`⚠️ 动作 ${result.action} 已执行，但它未必拦得住：${result.warning}`);
      }
    }
  }

  for (const verdict of verdicts) {
    const ownsAction = verdict.policyId === actedPolicyId;

    deps.store.save({
      eventId: event.id,
      // 事件快照。它是「事后按项目看」的全部依据 —— MR 标题会被改、分支会被删，
      // 事件源也不会回放同一份 payload，所以判的时候就得抄下来。
      project: event.project,
      author: event.author,
      title: event.title,
      eventKind: event.kind,
      changedFiles: event.changedFiles,
      sha: event.sha,
      mrIid: event.mrIid,
      policyId: verdict.policyId,
      policyVersion: verdict.policyVersion,
      outcome: verdict.outcome,
      reason: verdict.reason,
      precondition: verdict.precondition,
      evidenceJson: JSON.stringify(verdict.evidence),
      // 用量只在真的调过模型时才有（纯规则策略没有）—— 留空，不编一个零出来：
      // 「没有这次调用」与「这次调用花了零」是两件事
      usageJson: verdict.modelUsage ? JSON.stringify(verdict.modelUsage) : undefined,
      // 动作只记在发起它的那条策略上。一次事件只动了一次手，把它记进
      // 每一条命中记录里，会让「这条策略被处置过几次」凭空翻倍。
      action: ownsAction ? lead!.disposal.action : undefined,
      actionLevel: ownsAction ? lead!.disposal.level : undefined,
      externalRef: ownsAction ? actedExternalRef : undefined,
      // 管道跑的是生效判定。影子判定由双轨那条路单独写（见设计 §3.8），
      // 它不走 pipeline —— 因为它不产生动作，也不进观察期的分母。
      origin: 'effective',
      createdAt: now().toISOString(),
    });
    recorded += 1;
  }

  return { event, verdicts, actions, recorded, skippedByTrigger };
}
