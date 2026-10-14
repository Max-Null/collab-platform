import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionRunner, ActionContext } from './commenter.js';
import type { GitLabApi } from '../gitlab/api.js';
import type { ActionResult } from '../types.js';

/**
 * 挂起合并（级别 3）。
 *
 * ## 先说清楚它在当前环境里能做到什么
 *
 * **自建 GitLab 是社区版**（实测 15.7.2，`enterprise: false`），
 * 而 **Blocking merge requests 是 Premium 特性** —— `/merge_requests/:iid/blocks`
 * 返回 404。所以「拦」这件事**落不到 GitLab 的阻断 API 上**，只能落在
 * **分支保护的合并权限**上：只有当 Allowed to merge 被收窄到 GM（而不是
 * Maintainers）时，「GM 不批准」才真的等于「合不了」。
 *
 * 这个动作因此做三件事：
 *
 * 1. **自检「拦得住吗」** —— 读目标分支的保护配置。这是最关键的一步：
 *    评论发出去了、标记打上了，看起来「GM 拦了」，而如果那个仓库还是
 *    Maintainers 都能合，**这次拦截就没有发生**。那种「看起来做了」正是
 *    平台存在的理由要防的东西，所以它宁可自己说出来。
 * 2. **打挂起标记**（label）—— 一个**可查的状态**，不依赖人记得读评论。
 * 3. **发一条明确「不批准」的评论** —— 措辞比级别 1 的「提示复核」硬，
 *    因为它表达的是决定，不是意见。
 *
 * ## 三条件
 *
 * - **退出**：人放行 = 撤销这个动作（撤销时去标记 + 发一条「已放行」）
 * - **幂等**：管道层保证（同一事件 + 策略 + 版本只判一次）；label 用整体
 *   设置而不是追加，重复执行不会叠加
 * - **回滚**：`npm run undo` 删评论；标记由撤销流程去掉
 */
export class GitLabHoldMergeAction implements ActionRunner {
  readonly name = 'hold_merge';

  constructor(
    private readonly cfg: {
      api: GitLabApi;
      project: string;
      /** 写开关。关着时只渲染不发送 —— 与评论动作同一套规矩 */
      write: boolean;
      outDir: string;
      /** 挂起标记的 label 名 */
      label?: string;
      /** 哪个分支算「主干」。缺省用事件里的目标分支 */
      mainBranch?: string;
    },
  ) {}

  async run(ctx: ActionContext): Promise<ActionResult> {
    const mrIid = ctx.event.mrIid;
    if (mrIid === undefined) {
      return {
        action: this.name,
        ok: false,
        error: '这个事件没有 MR 编号，挂起合并无从下手（事件源可能不是 GitLab）',
      };
    }

    const label = this.cfg.label ?? 'GM:挂起';
    const target = this.cfg.mainBranch ?? ctx.event.targetBranch;

    // ① 自检：这次拦截到底拦不拦得住。**先算，因为它决定结果里有没有 warning**
    let warning: string | undefined;
    try {
      warning = await this.whyNotBlockable(target);
    } catch (e) {
      // 查不到保护配置 ≠ 拦得住。**如实说查不到**，而不是当成通过。
      // 这句话要完整 —— 只把「403 Forbidden」塞进 warning，读的人无从知道
      // 它意味着什么（那是异常信息，不是结论）。
      warning = `查不到分支保护配置（${e instanceof Error ? e.message : String(e)}）—— 所以无法确认这次挂起拦不拦得住`;
    }

    const body = [
      '## GM：这次变更暂不放行',
      '',
      `已挂起（标记 \`${label}\`），请先处理下面这些再合：`,
      '',
      ...ctx.verdicts
        .filter((v) => v.outcome === 'hit')
        .map((v, i) => {
          const pre = v.precondition ? `\n> ⚠️ 成立前提：${v.precondition}` : '';
          const ev = v.evidence
            .map((e) => `  - \`${e.kind}\` ${e.detail}${e.ref ? `（出处：\`${e.ref}\`）` : ''}`)
            .join('\n');
          return `**${i + 1}. ${v.reason ?? '需要确认'}**${pre}\n\n${ev}`;
        }),
      '',
      '---',
      '',
      '这不是否决，是**要求先有人看过**。放行由人决定。',
      '策略与版本见平台上的判断记录。',
      warning ? `\n> ⚠️ **平台自检**：${warning}` : '',
      ,
    ]
      .filter((l) => l !== '')
      .join('\n');

    if (!this.cfg.write) {
      const file = await this.writeDryRun(mrIid, body, label);
      return {
        action: this.name,
        ok: true,
        output: `（干燥跑，没有真挂起）本会挂起 MR !${mrIid}：打标记「${label}」并评论\n\n${body}\n\n→ 正文已写到 ${file}`,
        warning: warning,
      };
    }

    try {
      // ② 确保 label 存在 —— 不存在就创建。**不做的话，打标记会失败**，
      //    而失败的动作等于没拦，且看起来只是"一个 label 没打上"。
      const existing = await this.cfg.api.listLabels(this.cfg.project);
      if (!existing.includes(label)) {
        await this.cfg.api.createLabel(this.cfg.project, label);
      }

      // ③ 挂起标记：整体设置，不是追加 —— 撤销时才能对称地减掉
      const current = await this.currentLabels(mrIid);
      const next = [...new Set([...current.filter((l) => l !== label), label])];
      await this.cfg.api.setLabels(this.cfg.project, mrIid, next);

      // ④ 评论
      const note = await this.cfg.api.createNote(this.cfg.project, mrIid, body);

      return {
        action: this.name,
        ok: true,
        output: `已挂起 MR !${mrIid}：标记「${label}」+ 评论（note ${note.id}）`,
        // 记 note id 供撤销用；label 名与 MR 编号由事件与配置推得，不重复记
        externalRef: String(note.id),
        warning: warning,
      };
    } catch (err) {
      return {
        action: this.name,
        ok: false,
        output: body,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 这次「拦」拦得住吗？拦不住就说清为什么。
   *
   * 判据只看一件事：**目标分支的 Allowed to merge 里有没有「比 GM 更宽」的档位**。
   * GitLab 的 access_level 是 0=No one / 30=Developer / 40=Maintainer ——
   * 只要出现 ≥30 的档位，就说明有别人能合掉这条 MR，挂起挡不住他们。
   */
  private async whyNotBlockable(branch: string): Promise<string | undefined> {
    const branches = await this.cfg.api.getProtectedBranches(this.cfg.project);
    const target = branches.find((b) => b.name === branch);

    if (!target) {
      return `目标分支 \`${branch}\` 没有受保护 —— 谁都能直接推，挂起标记拦不住任何东西`;
    }

    const open = (target.merge_access_levels ?? []).filter((l) => l.access_level >= 30);
    if (open.length > 0) {
      const who = open.map((l) => l.access_level_description ?? `权限档 ${l.access_level}`).join('、');
      return (
        `目标分支 \`${branch}\` 的 Allowed to merge 是「${who}」——` +
        `不止 GM 能合，这次挂起**拦不住那些人**`
      );
    }

    return undefined;
  }

  /** 读这个 MR 当前的 label 名（用于整体设置） */
  private async currentLabels(mrIid: number): Promise<string[]> {
    const mr = await this.cfg.api.getMergeRequest(this.cfg.project, mrIid);
    return mr.labels ?? [];
  }

  private async writeDryRun(mrIid: number, body: string, label: string): Promise<string> {
    mkdirSync(this.cfg.outDir, { recursive: true });
    const file = join(this.cfg.outDir, `mr-${mrIid}-hold.md`);
    writeFileSync(file, `<!-- 挂起标记：${label} -->\n${body}`, 'utf8');
    return file;
  }
}
