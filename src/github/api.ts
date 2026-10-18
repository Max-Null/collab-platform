/**
 * GitHub API 客户端。
 *
 * 与 `gitlab/api.ts` 是**同一层的东西、同一套约定**：用 `fetch` 直连、不引 SDK、
 * 读接口与写接口在命名上就分开。两边的差异只该停在协议细节上，不该跑到语义上。
 *
 * 三处 GitHub 特有的坑，写在最前面：
 *
 * ① **`User-Agent` 是必须的。** 缺了它 GitHub 直接回 403，而 403 读起来像「没权限」，
 *    排查时不会有人想到是少了一个头。
 * ② **`patch` 字段可能不存在。** 大文件、二进制、或改动过大时，`/files` 只给文件名
 *    不给 patch。这时 diff 是「取到了但是空的」还是「根本没给」，要与其它取数失败
 *    区分开 —— 判据那边靠这个决定落 `error` 还是干脆不判。
 * ③ **PR 的评论走 issues 接口。** `POST /repos/{o}/{r}/issues/{n}/comments` ——
 *    在 GitHub 的模型里 PR 就是一种 issue。
 */

export interface GitHubConfig {
  /** 企业版形如 https://github.enterprise/api/v3；公开版默认 https://api.github.com */
  baseUrl?: string;
  token: string;
  timeoutMs?: number;
}

/** GitHub 的 PR（这里只留平台用得上的字段） */
export interface GitHubPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user?: { login?: string };
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
  /** draft 的 PR 也是一个 PR —— 它甚至会一直停在 draft，所以要看得到 */
  draft?: boolean;
}

/** `/files` 里的一项。`patch` 可能缺席，见文件抬头的 ② */
export interface GitHubFile {
  filename: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
  /** 重命名时，改之前的名字 */
  previous_filename?: string;
}

export interface GitHubCommitRef {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; date?: string };
  };
  /** 两个以上父提交 = 合并提交。事件源靠它跳过，理由见 gitlab-push.ts */
  parents: Array<{ sha: string }>;
}

export class GitHubApi {
  readonly name = 'github-api';

  constructor(private readonly cfg: GitHubConfig) {}

  private base(): string {
    return (this.cfg.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base()}${path}`, {
      ...init,
      headers: {
        // `User-Agent` 缺了会 403 —— 见文件抬头 ①
        'user-agent': 'collab-platform',
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${this.cfg.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} → HTTP ${res.status}：${body.slice(0, 300)}`);
    }
    // 204 没有 body（删评论之类）
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `owner/repo` → 路径段。两段分别编码，斜杠保留。 */
  private static seg(project: string): string {
    const [owner, repo] = project.split('/');
    if (!owner || !repo) throw new Error(`仓库标识要写成 owner/repo：${project}`);
    return `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  /**
   * PR 列表 —— 轮询事件源的第一跳。
   *
   * `state` 用 GitHub 的取值（open / closed / all）。允许取历史状态不是为了日常跑，
   * 是为了拿真实的历史 PR 做演练 —— 一个刚接入的平台最缺的是素材。
   */
  async listPullRequests(
    project: string,
    opts: { state?: string; limit?: number } = {},
  ): Promise<GitHubPull[]> {
    const state = opts.state ?? 'open';
    const limit = Math.min(opts.limit ?? 20, 100); // GitHub 的 per_page 上限就是 100
    return this.req<GitHubPull[]>(
      `/repos/${GitHubApi.seg(project)}/pulls` +
        `?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${limit}`,
    );
  }

  /**
   * 把 GitHub 的文件数组收成「文件列表 + diff 文本」。
   *
   * 与 GitLab 那边的 `shapeChanges` 同一职责。**没有 patch 的文件不伪装成空改动** ——
   * 它的 diff 段留一句说明，人读记录时能看出「这个文件 GitHub 没给 patch」，
   * 而不是以为它一行都没改。
   */
  private shapeFiles(files: GitHubFile[]): { changedFiles: string[]; diff: string } {
    const changedFiles = files.map((f) =>
      f.previous_filename ? `${f.previous_filename} → ${f.filename}` : f.filename,
    );

    const diff = files
      .map((f) => {
        const head = `diff --git a/${f.previous_filename ?? f.filename} b/${f.filename}`;
        if (f.patch) return `${head}\n${f.patch}`;
        return `${head}\n（GitHub 没有为这个文件提供 patch —— 通常是二进制、或改动过大）`;
      })
      .join('\n');

    return { changedFiles, diff };
  }

  /** 取一次 PR 的改动：文件列表 + 拼回完整 diff 的文本 */
  async fetchChanges(project: string, number: number): Promise<{ changedFiles: string[]; diff: string }> {
    const files = await this.req<GitHubFile[]>(
      `/repos/${GitHubApi.seg(project)}/pulls/${number}/files?per_page=100`,
    );
    return this.shapeFiles(files);
  }

  /** 单个 PR 的详情 —— 撤销与「这个 PR 现在什么状态」要用 */
  getPullRequest(project: string, number: number): Promise<GitHubPull> {
    return this.req<GitHubPull>(`/repos/${GitHubApi.seg(project)}/pulls/${number}`);
  }

  /**
   * 某个分支上的提交。`sha` 不传就是默认分支。
   *
   * ⚠️ GitHub 按**时间倒序**返回，而 GitLab 那边也是 —— 但两边的「最近 100 条」
   * 含义不同：GitHub 的分页是按提交历史顺序，不会因为 force push 改变。
   */
  listCommits(
    project: string,
    opts: { refName?: string; limit?: number } = {},
  ): Promise<GitHubCommitRef[]> {
    const limit = Math.min(opts.limit ?? 20, 100);
    const q = new URLSearchParams({ per_page: String(limit) });
    if (opts.refName) q.set('sha', opts.refName);
    return this.req<GitHubCommitRef[]>(`/repos/${GitHubApi.seg(project)}/commits?${q.toString()}`);
  }

  /** 取一次提交的改动。GitHub 的 commit 详情自带 files，省一趟请求。 */
  async fetchCommitChanges(
    project: string,
    sha: string,
  ): Promise<{ changedFiles: string[]; diff: string }> {
    const c = await this.req<GitHubCommitRef & { files?: GitHubFile[] }>(
      `/repos/${GitHubApi.seg(project)}/commits/${sha}`,
    );
    return this.shapeFiles(c.files ?? []);
  }

  /* ── 以下开始是写接口。平台在真仓库上跑的第一阶段只该用上面那些 ── */

  /**
   * 在 PR 上发一条评论。
   *
   * 走的是 **issues** 接口 —— GitHub 的模型里 PR 就是一种 issue。
   * 发 failed 时返回的 `html_url` 就是外面引用（`externalRef`），
   * 撤销要靠它找回那一条。
   */
  async createComment(project: string, number: number, body: string): Promise<{ id: number; html_url: string }> {
    return this.req<{ id: number; html_url: string }>(
      `/repos/${GitHubApi.seg(project)}/issues/${number}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
    );
  }

  /** 删一条评论 —— 撤销要用 */
  async deleteComment(project: string, commentId: number | string): Promise<void> {
    await this.req<void>(`/repos/${GitHubApi.seg(project)}/issues/comments/${commentId}`, {
      method: 'DELETE',
    });
  }

  /**
   * 给 PR 提交一次 review（REQUEST_CHANGES）。
   *
   * 这是 GitHub 上「挂起合并」的对应物：它不合并，但会留下一个明确的
   * changes-requested 状态。⚠️ 它的效力取决于仓库的分支保护配置 ——
   * 没有开「Require review before merging」的话，它和一条普通评论没区别。
   * 这一点与 GitLab 那边 `hold_merge` 的自检是同一个道理：**动作做成 ≠ 拦住了**。
   */
  async requestChanges(project: string, number: number, body: string): Promise<{ id: number }> {
    return this.req<{ id: number }>(`/repos/${GitHubApi.seg(project)}/pulls/${number}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ event: 'REQUEST_CHANGES', body }),
    });
  }

  /** 仓库信息 —— 用来确认 token 到底看得见什么、默认分支是哪个 */
  getRepo(project: string): Promise<{ full_name: string; default_branch: string; private: boolean }> {
    return this.req(`/repos/${GitHubApi.seg(project)}`);
  }
}
