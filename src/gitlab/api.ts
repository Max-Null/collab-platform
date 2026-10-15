/**
 * GitLab API 客户端。
 *
 * 只实现这一版真正要用到的三个端点，用 `fetch` 直连，不引 SDK。
 *
 * 一条刻意的区分：**读接口与写接口在这里就分开命名**（list / fetch 与 create）。
 * 平台在真仓库上跑的早期阶段只该用读，写要靠配置显式打开（见 gitlab-comment.ts）。
 */

export interface GitLabConfig {
  /** 形如 https://gitlab.example.com —— 结尾有没有斜杠都行 */
  baseUrl: string;
  /** 令牌，见 tokenKind */
  token: string;
  /**
   * 令牌形态，决定发哪个头：
   * - `private-token`（默认）→ `PRIVATE-TOKEN`，Personal / Project Access Token 走这个，推荐的长期形态；
   * - `bearer` → `Authorization: Bearer`，OAuth access token 走这个（用户名密码换来的那种，两小时过期）。
   *
   * 由调用方明确指定，**不靠猜字符串前缀** —— 猜错了得到的是 401，
   * 而 401 跟「令牌真的错了」长得一模一样，排查时不会有人想到是发错了头。
   */
  tokenKind?: 'private-token' | 'bearer';
  timeoutMs?: number;
  /**
   * 换一个新令牌。给了它，请求遇到 401 时会自动换一次并原样重发。
   *
   * **为什么是「遇到 401 才换」而不是定时刷新**：OAuth 令牌两小时过期是必然会
   * 发生的事，而定时刷新要维护「什么时候到期」这份状态 —— 多一份状态就多一处
   * 会不同步的地方。401 是 GitLab 亲口说的「你的令牌不认了」，拿它当触发器不用猜。
   */
  refresh?: () => Promise<string>;
}

/**
 * 用用户名 + 密码换一个 OAuth access token。
 *
 * 这不是推荐做法 —— 它意味着平台需要持有 GitLab 密码，而且换来的令牌两小时就过期。
 * 留在这里是因为**验证阶段往往还没有 PAT**，而「先能跑起来看一眼」比「配齐凭据再动手」
 * 更早暴露真问题。日常应当改用 Personal Access Token。
 */
export async function fetchOAuthToken(cfg: {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}): Promise<string> {
  const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      username: cfg.username,
      password: cfg.password,
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 30_000),
  });

  if (!res.ok) {
    throw new Error(`换 GitLab 令牌失败：HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('换 GitLab 令牌失败：响应里没有 access_token');
  return data.access_token;
}

export interface GitLabMr {
  iid: number;
  title: string;
  description: string | null;
  target_branch: string;
  updated_at: string;
  /** 最新 commit 的 sha —— 它让「同一个 MR 的新版本」成为新事件 */
  sha?: string;
  author?: { username?: string };
}

export interface GitLabChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}

/**
 * 一个提交。
 *
 * 只看平台用得上的几个字段：`title`（第一行）与 `message`（全文）构成**主张** ——
 * 「改动与声称是否相符」那条策略检验的就是它，只不过对 MR 时主张来自人工写的描述，
 * 对提交时来自提交消息。这也是接入记录里那句「push 没有可检验的主张」需要修正的地方：
 * 提交消息就是主张，只是它比 MR 描述短、也更少被认真写。
 */
export interface GitLabCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
  committed_date: string;
  /**
   * 父提交。**两个以上说明这是一次合并提交** —— 事件源靠它跳过合并:
   * 合并提交的 diff 是「被合进来的那些改动的合集」，而那些提交各自也已经报过一次，
   * 不跳过就会把同一处变更判两遍 —— 观察期的分母最怕的正是重复计数。
   */
  parent_ids?: string[];
}

export class GitLabApi {
  readonly name = 'gitlab-api';

  constructor(private readonly cfg: GitLabConfig) {}

  /** 发一次请求，带上当前令牌。抽出来是为了 401 之后能原样再发一次。 */
  private send(path: string, init?: RequestInit): Promise<Response> {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}/api/v4${path}`;

    return fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.tokenKind === 'bearer'
          ? { authorization: `Bearer ${this.cfg.token}` }
          : { 'PRIVATE-TOKEN': this.cfg.token }),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res = await this.send(path, init);

    // 401 且能换令牌 → 换一个再原样发一次。
    //
    // 常驻进程里的令牌过期不是异常，是**必然会发生的日常**：用户名密码换来的
    // OAuth 令牌两小时就过期。不处理它的后果很具体 —— 跑满两小时后每一轮都失败，
    // 而「每轮都失败」在心跳里是看得见的（ok=false + 原因），但「看得见」不等于
    // 「不用管」：一个每天要人重启一次的平台，等于又回到了要人手动触发的老路。
    //
    // **只重试一次**：再失败就是真没权限或密码错了，那时该如实报错，而不是循环重试 ——
    // 循环重试会把一个明确的错误变成一段看不出因果的日志。
    if (res.status === 401 && this.cfg.refresh) {
      this.cfg.token = await this.cfg.refresh();
      res = await this.send(path, init);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `GitLab ${init?.method ?? 'GET'} ${path} → HTTP ${res.status}：${body.slice(0, 300)}`,
      );
    }
    return (await res.json()) as T;
  }

  private static seg(project: string): string {
    return encodeURIComponent(project);
  }

  /**
   * MR 列表 —— 轮询事件源的第一跳。
   *
   * `state` 默认只取 opened。**允许取历史状态不是为了日常跑**，是为了拿真实的
   * 历史 MR 做演练：一个刚接入的平台最缺的是素材，而历史 MR 是现成的、
   * 只读的，且早就没人会因为它多出一条评论而受影响。
   */
  listMergeRequests(
    project: string,
    opts: { state?: string; limit?: number } = {},
  ): Promise<GitLabMr[]> {
    const state = opts.state ?? 'opened';
    const limit = opts.limit ?? 20;

    return this.req<GitLabMr[]>(
      `/projects/${GitLabApi.seg(project)}/merge_requests` +
        `?state=${encodeURIComponent(state)}&order_by=updated_at&sort=desc&per_page=${limit}`,
    );
  }

  /**
   * 把 GitLab 的改动数组收成「文件列表 + diff 文本」。
   *
   * MR 的 `/changes` 与提交的 `/commits/:sha/diff` 返回的是**同一种结构**，
   * 所以解析只该有一份。两份写的后果不是语法错，而是它们会慢慢分叉 ——
   * 分叉点在「重命名怎么记」这种细节上，而没有人会去核对两处是否还一致。
   */
  private shapeChanges(changes: GitLabChange[]): { changedFiles: string[]; diff: string } {
    return {
      // 重命名时两个路径都留 —— 只记 new_path 会看不出「这个文件原来叫什么」
      changedFiles: changes.map((c) =>
        c.renamed_file ? `${c.old_path} → ${c.new_path}` : c.new_path,
      ),
      diff: changes
        .map((c) => `diff --git a/${c.old_path} b/${c.new_path}\n${c.diff}`)
        .join('\n'),
    };
  }

  /**
   * 取一次 MR 的改动：文件列表 + 拼回完整 diff 的文本。
   *
   * **这两个值正是策略 gather 白名单里的 `changed_files` 与 `diff`。**
   * 取数是判据的前置环节，货不对板的时候必须由调用方当「没做成」处理 ——
   * 一个空的文件列表看起来和一次干净的改动没有区别。
   */
  async fetchChanges(
    project: string,
    mrIid: number,
  ): Promise<{ changedFiles: string[]; diff: string }> {
    const data = await this.req<{ changes?: GitLabChange[] }>(
      `/projects/${GitLabApi.seg(project)}/merge_requests/${mrIid}/changes`,
    );
    return this.shapeChanges(data.changes ?? []);
  }

  /**
   * 分支上的提交列表 —— 推送事件源的第一跳。
   *
   * 轮询能看到的不是「一次推送」这个动作，而是「分支现在在哪」。所以单元取**提交**：
   * 事件 id 里带 sha，「这个提交被审过没有」才有答案，而不是「这个分支被审过没有」。
   */
  listCommits(
    project: string,
    opts: { refName?: string; limit?: number } = {},
  ): Promise<GitLabCommit[]> {
    const limit = opts.limit ?? 20;
    const ref = opts.refName ? `&ref_name=${encodeURIComponent(opts.refName)}` : '';
    return this.req<GitLabCommit[]>(
      `/projects/${GitLabApi.seg(project)}/repository/commits?per_page=${limit}${ref}`,
    );
  }

  /** 一个提交的改动 —— 与 MR 的 `/changes` 同构，因此共用同一份解析 */
  async fetchCommitChanges(
    project: string,
    sha: string,
  ): Promise<{ changedFiles: string[]; diff: string }> {
    const changes = await this.req<GitLabChange[]>(
      `/projects/${GitLabApi.seg(project)}/repository/commits/${sha}/diff`,
    );
    return this.shapeChanges(changes);
  }

  /** 在 MR 下发一条评论 —— **写操作**，只在显式打开写开关时才会被调用 */
  createNote(
    project: string,
    mrIid: number,
    body: string,
  ): Promise<{ id: number; web_url?: string }> {
    return this.req<{ id: number; web_url?: string }>(
      `/projects/${GitLabApi.seg(project)}/merge_requests/${mrIid}/notes`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }

  /**
   * 删掉一条评论 —— **写操作，且是回滚那一半**。
   *
   * 「退出 / 幂等 / 回滚」三条件里，回滚是平台唯一空缺的那条：
   * 发出去的评论默认收不回来。有了它，错发才是一个可撤销的动作，
   * 而不是一次留在别人仓库里的既成事实。
   */
  deleteNote(project: string, mrIid: number, noteId: string | number): Promise<void> {
    return this.req<void>(
      `/projects/${GitLabApi.seg(project)}/merge_requests/${mrIid}/notes/${noteId}`,
      { method: 'DELETE' },
    );
  }

  /** 读一个 MR 的详情（挂起动作要靠它拿当前的 label，做整体设置而不是追加） */
  getMergeRequest(
    project: string,
    mrIid: number,
  ): Promise<{ iid: number; labels?: string[]; state?: string }> {
    return this.req(`/projects/${GitLabApi.seg(project)}/merge_requests/${mrIid}`);
  }

  /**
   * 读一个仓库的**受保护分支**配置。
   *
   * 平台拿它回答一个要命的问题：**「GM 拦得住吗」**。
   *
   * ⚠️ 因为自建 GitLab 是**社区版**（实测 15.7.2，`enterprise: false`），
   * Blocking merge requests 那个 API 返回 404 —— 它是 Premium 特性。
   * 所以"拦"落不到 GitLab 的阻断 API 上，只能落在**分支保护的合并权限**上：
   * 只有当 Allowed to merge 被收窄到 GM（而不是 Maintainers）时，
   * 「GM 不批准」才真的等于「合不了」。
   */
  getProtectedBranches(project: string): Promise<
    Array<{
      name: string;
      push_access_levels?: Array<{ access_level: number; access_level_description?: string }>;
      merge_access_levels?: Array<{ access_level: number; access_level_description?: string }>;
    }>
  > {
    return this.req(`/projects/${GitLabApi.seg(project)}/protected_branches`);
  }

  /** 列出仓库现有的 label 名 —— 「不存在则创建」要靠它，否则创建接口会因重名报错 */
  async listLabels(project: string): Promise<string[]> {
    const rows = await this.req<Array<{ name: string }>>(
      `/projects/${GitLabApi.seg(project)}/labels?per_page=100`,
    );
    return rows.map((r) => r.name);
  }

  /** 创建一个 label —— **写操作** */
  createLabel(project: string, name: string, color = '#C0392B'): Promise<unknown> {
    const qs = new URLSearchParams({ name, color }).toString();
    return this.req(`/projects/${GitLabApi.seg(project)}/labels?${qs}`, { method: 'POST' });
  }

  /**
   * 把一组 label **整体设置**到 MR 上（`PUT` 的语义是覆盖 `labels` 字段）。
   *
   * 用整体设置而不是 add：GitLab 的 `add_labels` 只增不减，
   * 撤销时减不掉。整体设置让「挂起」与「放行」互相对称 —— 而对称是可回滚的前提。
   */
  setLabels(project: string, mrIid: number, labels: string[]): Promise<unknown> {
    const qs = new URLSearchParams({ labels: labels.join(',') }).toString();
    return this.req(`/projects/${GitLabApi.seg(project)}/merge_requests/${mrIid}?${qs}`, {
      method: 'PUT',
    });
  }
}
