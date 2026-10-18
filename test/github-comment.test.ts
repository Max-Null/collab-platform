import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { GitHubCommentAction } from '../src/action/github-comment.js';
import type { GitHubApi } from '../src/github/api.js';
import type { ChangeEvent, PolicyVerdict } from '../src/types.js';

/**
 * GitHub 上的评论动作。
 *
 * 与 GitLab 那边是同一组判据，所以测的也是同一组东西：
 * **干燥跑走的是与真发同一条路径**、**没有落点时明确拒绝而不是硬造一个**、
 * **发失败要如实报**。差一个，就会出现「记录里写着已评论、实际没发出去」。
 */

const root = process.cwd();
// 每个测试文件用自己的目录 —— 见 test/pipeline.test.ts 里那段关于并发的说明
const outDir = resolve(root, 'var/test-comments/github-comment');

const event = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  id: 'github-o-r-pr-7-abcdef12',
  source: 'github',
  kind: 'mr',
  project: 'o/r',
  mrIid: 7,
  sha: 'abcdef1234567890',
  title: 'feat: 加个配置',
  description: '只改配置',
  author: 'zhang',
  targetBranch: 'main',
  changedFiles: ['a.yml'],
  diff: 'diff --git a/a.yml b/a.yml',
  occurredAt: '2026-10-18T01:00:00Z',
  ...over,
});

const verdicts: PolicyVerdict[] = [
  {
    policyId: 'review-sensitive-path',
    policyVersion: 'v1',
    outcome: 'hit',
    reason: '改动触及敏感路径',
    evidence: [{ kind: 'changed_file', detail: 'a.yml', ref: 'a.yml' }],
  },
];

/** 记录调用、按需抛错的假 api */
function fakeApi(opts: { fail?: boolean } = {}) {
  const calls: Array<{ project: string; number: number; body: string }> = [];
  const api = {
    async createComment(project: string, number: number, body: string) {
      calls.push({ project, number, body });
      if (opts.fail) throw new Error('HTTP 403：Resource not accessible by integration');
      return { id: 98765, html_url: 'https://github.com/o/r/pull/7#issuecomment-98765' };
    },
  } as unknown as GitHubApi;
  return { api, calls };
}

test('写开关关着时只落文件，不发出去 —— 正文与真发的是同一份', async () => {
  const { api, calls } = fakeApi();
  const action = new GitHubCommentAction({ api, project: 'o/r', write: false, outDir });

  const res = await action.run({ event: event(), verdicts }, 1);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 0, '写开关关着就不该碰 GitHub');
  assert.match(res.output ?? '', /\[dry-run\] 未发送到 GitHub/);

  const file = readFileSync(resolve(outDir, `${event().id}.md`), 'utf8');
  assert.ok(file.includes('a.yml'), '落盘的就是会发出去的那份正文');
});

test('写开关打开时发到 PR，并记下外部引用 —— 撤销要靠它找回那一条', async () => {
  const { api, calls } = fakeApi();
  const action = new GitHubCommentAction({ api, project: 'o/r', write: true, outDir });

  const res = await action.run({ event: event(), verdicts }, 1);

  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.project, 'o/r');
  assert.equal(calls[0]!.number, 7);
  assert.equal(res.externalRef, '98765', '没有 externalRef 就撤不回来');
  assert.match(res.output ?? '', /已评论 PR #7/);
});

test('推送事件没有 PR 号：明确拒绝，不硬造一个落点', async () => {
  const { api, calls } = fakeApi();
  const action = new GitHubCommentAction({ api, project: 'o/r', write: true, outDir });

  const res = await action.run(
    { event: event({ kind: 'push', mrIid: undefined, id: 'github-push-o-r-abc' }), verdicts },
    1,
  );

  assert.equal(res.ok, false, '没有落点要如实失败');
  assert.equal(calls.length, 0, '更不能偷偷发到别处');
  assert.match(res.error ?? '', /没有 PR 编号/);
  assert.match(res.error ?? '', /动作没做成/, '要说清记录那边会怎么标');
});

test('发失败时如实报错，不留一条「已评论」的假记录', async () => {
  const { api } = fakeApi({ fail: true });
  const action = new GitHubCommentAction({ api, project: 'o/r', write: true, outDir });

  const res = await action.run({ event: event(), verdicts }, 1);

  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /HTTP 403/);
  assert.equal(res.externalRef, undefined, '没发成功就不该有外部引用');
});
