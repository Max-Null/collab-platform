import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubApi } from './github/api.js';
import { GitLabApi, fetchOAuthToken } from './gitlab/api.js';
import { RecordStore } from './record/store.js';

/**
 * 撤销一次已经发出去的动作。
 *
 * 「退出 / 幂等 / 回滚」三条件里，**回滚是平台唯一空缺的那条** ——
 * 本地评论删个文件就完了，发到 GitLab 的评论却收不回来。而这条空缺
 * 只在写开关打开之后才成为真问题，所以更该在那之前就位。
 *
 * 三条刻意的设计：
 *
 * ① **默认 dry-run**，`--apply` 才真删。撤销是不可逆的写操作，
 *    而「先看见将要发生什么」是它该有的默认姿势。
 * ② **不删判断记录，只标 `undone_at`**。「发出去了又收回」本身是该
 *    看得见的一件事，不是一件应该消失的事。
 * ③ **找得到才撤** —— 没有 `externalRef` 的判定直接拒绝，不猜。
 *    猜错意味着删掉别人的评论，那比不撤严重得多。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();

const { values } = parseArgs({
  options: {
    judgment: { type: 'string' },
    db: { type: 'string', default: 'var/platform.db' },
    apply: { type: 'boolean', default: false },
    host: { type: 'string', default: 'gitlab' },
    // 撤销要发 DELETE，所以必须有 GitLab 凭据 —— 即使当初是干燥跑发的
    'dry-run-note': { type: 'string' },
  },
  allowPositionals: false,
});

const log = (m: string): void => {
  process.stdout.write(`${m}\n`);
};

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`撤销要配环境变量 ${name}（它需要发 DELETE 请求）`);
  return v;
}

/**
 * 从事件 id 里取回 MR 编号。
 *
 * 事件 id 的形状是 `gitlab-<项目名转写>-<mrIid>-<sha>`（见 `GitLabPollSource`）。
 * **解析失败就拒绝**，不猜 —— 猜错会删掉别的 MR 上的评论。
 */
function mrIidFromEventId(eventId: string): number {
  const m = /^gitlab-.*-(\d+)-[0-9a-f]{6,}$/.exec(eventId);
  if (!m) throw new Error(`从事件 id 里取不出 MR 编号：${eventId}（拒绝猜）`);
  return Number(m[1]);
}

async function main(): Promise<void> {
  const id = Number(values.judgment);
  if (!Number.isInteger(id)) {
    throw new Error('用法：--judgment <判断记录 id> [--apply]');
  }

  const dbPath = values.db === ':memory:' ? ':memory:' : resolve(root, values.db);
  const store = new RecordStore(dbPath);

  const row = store.findById(id);
  if (!row) {
    store.close();
    throw new Error(`没有 id 为 ${id} 的判断记录`);
  }

  log(`判断记录 #${id}`);
  log(`  事件：${row.eventId}`);
  log(`  策略：${row.policyId} @ ${row.policyVersion} → ${row.outcome}`);
  log(`  动作：${row.action ?? '（没有动作）'}${row.actionLevel ? ` · 级别 ${row.actionLevel}` : ''}`);

  if (!row.action) {
    store.close();
    throw new Error('这条判定没有执行过动作，没什么可撤的');
  }
  if (!row.externalRef) {
    store.close();
    throw new Error(
      '这条判定没有记下外部引用 —— 可能是干燥跑（没真发出去），' +
        '也可能是动作不支持撤销。**不猜**，所以不撤。',
    );
  }
  if (row.undoneAt) {
    store.close();
    throw new Error(`这条动作已经在 ${row.undoneAt} 撤过了，不重复撤`);
  }

  /**
   * 撤销哪一边。
   *
   * ⚠️ **GitHub 与 GitLab 在这里的机制不同，不是换个 baseUrl 就行**：
   * GitLab 的评论是挂在 MR 上的（`DELETE /projects/:id/merge_requests/:iid/notes/:note`），
   * 所以要先从事件 id 里还原 MR 号；GitHub 的评论有自己的 id
   * （`DELETE /repos/:o/:r/issues/comments/:id`），**不需要 PR 号**。
   * 硬凑成一条路径的结果是删错东西或者删不掉，而「删不掉」会让人以为「撤销过了」。
   */
  const isGitHub = values.host === 'github';

  let mrIid: number | undefined;
  if (isGitHub) {
    log(`  将删除：GitHub 评论 ${row.externalRef}`);
  } else {
    mrIid = mrIidFromEventId(row.eventId);
    log(`  将删除：MR !${mrIid} 上的 note ${row.externalRef}`);
  }

  if (!values.apply) {
    log('');
    log('（dry-run，什么都没做。确认无误后加 --apply 真删。）');
    store.close();
    return;
  }

  if (isGitHub) {
    const api = new GitHubApi({ token: need('GITHUB_TOKEN') });
    await api.deleteComment(need('GITHUB_PROJECT'), row.externalRef);
  } else {
    const baseUrl = need('GITLAB_BASE_URL');
    let api: GitLabApi;
    const pat = process.env.GITLAB_TOKEN;
    if (pat) {
      api = new GitLabApi({ baseUrl, token: pat });
    } else {
      const token = await fetchOAuthToken({
        baseUrl,
        username: need('GITLAB_USER'),
        password: need('GITLAB_PASSWORD'),
      });
      api = new GitLabApi({ baseUrl, token, tokenKind: 'bearer' });
    }

    const project = need('GITLAB_PROJECT');
    await api.deleteNote(project, mrIid!, row.externalRef);
  }

  // 不删记录，只标时刻 —— 见文件头 ②
  store.setUndone(id, new Date().toISOString());
  log('');
  log(
    `✅ 已撤销：${isGitHub ? `GitHub 评论 ${row.externalRef}` : `MR !${mrIid} 的 note ${row.externalRef}`}` +
      ` 已删除，判断记录 #${id} 标为已撤销。`,
  );
  log('   （记录本身保留 —— 「发出去了又收回」也是这段留痕的一部分。）');

  store.close();
}

main().catch((e) => {
  process.stderr.write(`撤销失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
