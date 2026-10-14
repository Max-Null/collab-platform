import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { GitLabCommentAction } from '../src/action/gitlab-comment.js';
import { GitLabPollSource } from '../src/event/gitlab.js';
import { GitLabApi } from '../src/gitlab/api.js';
import { runPipeline } from '../src/pipeline.js';
import {
  createSensitivePathPolicy,
  loadSensitivePathConfig,
} from '../src/policy/sensitive-path.js';
import { RecordStore } from '../src/record/store.js';

const root = process.cwd();
const config = loadSensitivePathConfig(resolve(root, 'config/sensitive-paths.json'));
const outDir = resolve(root, 'var/test-gitlab-comments');

/**
 * 假 fetch：把请求记下来，按 URL 片段回预设响应。**不联网**，
 * 所以这些用例可以随便跑，也不会在真仓库上留下任何东西。
 */
function fakeFetch(routes: Record<string, unknown>, status = 200) {
  const calls: { url: string; method: string; token?: string; body?: string }[] = [];

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    calls.push({
      url,
      method: init?.method ?? 'GET',
      token: headers['PRIVATE-TOKEN'],
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response('{"message":"404 Not Found"}', { status: 404 });

    return new Response(JSON.stringify(routes[key]), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { impl, calls };
}

function withFetch<T>(impl: unknown, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

const api = (): GitLabApi =>
  new GitLabApi({ baseUrl: 'https://gitlab.example.com', token: 'test-token' });

const MR_LIST = [
  {
    iid: 7,
    title: '对账中心：调整发票状态字段',
    description: '加个状态字段',
    target_branch: 'main',
    updated_at: '2026-10-13T03:20:00.000Z',
    sha: 'abc123',
    author: { username: 'zhangsan' },
  },
];

const CHANGES = {
  changes: [
    {
      old_path: 'backend/doc/sql/10_tables.sql',
      new_path: 'backend/doc/sql/10_tables.sql',
      diff: '@@ -1,2 +1,3 @@\n+ALTER TABLE t ADD status TINYINT;',
    },
    {
      old_path: 'backend/src/Old.java',
      new_path: 'backend/src/New.java',
      diff: '@@ -1 +1 @@\n-old\n+new',
      renamed_file: true,
    },
  ],
};

// ── 读：轮询事件源 ──────────────────────────────────────

test('轮询：MR 列表 + changes 合成一个带文件与 diff 的事件', async () => {
  const f = fakeFetch({ '/merge_requests/7/changes': CHANGES, '/merge_requests?': MR_LIST });

  const events = await withFetch(f.impl, () =>
    new GitLabPollSource(api(), 'my-group/my-app').fetch(),
  );

  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.source, 'gitlab');
  assert.equal(e.mrIid, 7);
  assert.equal(e.author, 'zhangsan');
  assert.ok(e.changedFiles.includes('backend/doc/sql/10_tables.sql'));
  assert.ok(e.diff?.includes('ALTER TABLE t ADD status'), 'diff 要拼进事件');
  assert.ok(
    e.id.endsWith('abc123'),
    '事件 id 带 commit sha —— 同一个 MR 改一版就是一次新事件',
  );

  assert.ok(
    f.calls.every((c) => c.method === 'GET'),
    '事件源只做读操作，一个写请求都不该有',
  );
  assert.ok(
    f.calls.every((c) => c.token === 'test-token'),
    'token 走 PRIVATE-TOKEN 头',
  );
});

test('轮询：重命名的文件两个路径都留，否则看不出原来叫什么', async () => {
  const f = fakeFetch({ '/merge_requests/7/changes': CHANGES, '/merge_requests?': MR_LIST });

  const events = await withFetch(f.impl, () =>
    new GitLabPollSource(api(), 'my-group/my-app').fetch(),
  );

  assert.ok(
    events[0]!.changedFiles.some((p) => p === 'backend/src/Old.java → backend/src/New.java'),
  );
});

test('轮询：API 报错时要抛出，不能悄悄当成「没有事件」', async () => {
  const f = fakeFetch({});

  await assert.rejects(
    () => withFetch(f.impl, () => new GitLabPollSource(api(), 'my-group/my-app').fetch()),
    /HTTP 404/,
    '取不到事件与「没有待审 MR」是两件事，不能混',
  );
});

// ── 写：默认关闭 ────────────────────────────────────────

test('写开关关着：动作跑完但不发任何请求，正文落到本地', async () => {
  const f = fakeFetch({ '/merge_requests/7/changes': CHANGES, '/merge_requests?': MR_LIST });

  const events = await withFetch(f.impl, () =>
    new GitLabPollSource(api(), 'my-group/my-app').fetch(),
  );
  const event = events[0]!;

  const action = new GitLabCommentAction({
    api: api(),
    project: 'my-group/my-app',
    write: false,
    outDir,
  });

  const store = new RecordStore(':memory:');
  const sentBefore = f.calls.length;

  const result = await withFetch(f.impl, () =>
    runPipeline(event, {
      policies: [createSensitivePathPolicy(config)],
      actions: new Map([['comment', action]]),
      store,
    }),
  );

  assert.equal(result.verdicts[0]!.outcome, 'hit', 'SQL 文件应当命中敏感路径');
  assert.equal(result.actions[0]!.ok, true);
  assert.ok(result.actions[0]!.output?.includes('[dry-run]'));

  assert.equal(f.calls.length, sentBefore, 'dry-run 不该发出任何新请求');
  assert.ok(
    readFileSync(join(outDir, `${event.id}.md`), 'utf8').includes('review-sensitive-path'),
    '正文仍然落到本地，供人复核',
  );

  store.close();
});

test('写开关打开：评论发到 MR 的 notes 端点，正文与 dry-run 时一致', async () => {
  const f = fakeFetch({
    '/merge_requests/7/changes': CHANGES,
    '/merge_requests?': MR_LIST,
    '/notes': { id: 42, web_url: 'https://gitlab.example.com/note/42' },
  });

  const events = await withFetch(f.impl, () =>
    new GitLabPollSource(api(), 'my-group/my-app').fetch(),
  );
  const event = events[0]!;

  const store = new RecordStore(':memory:');
  const result = await withFetch(f.impl, () =>
    runPipeline(event, {
      policies: [createSensitivePathPolicy(config)],
      actions: new Map([
        [
          'comment',
          new GitLabCommentAction({
            api: api(),
            project: 'my-group/my-app',
            write: true,
            outDir,
          }),
        ],
      ]),
      store,
    }),
  );

  const noteCalls = f.calls.filter((c) => c.method === 'POST');
  assert.equal(noteCalls.length, 1, '只该发一条评论');
  assert.ok(noteCalls[0]!.url.endsWith('/projects/my-group%2Fmy-app/merge_requests/7/notes'));
  assert.ok(result.actions[0]!.output?.includes('note 42'));

  // 发出去的就是 dry-run 会落盘的那份文本 —— 干燥跑必须跑在真实代码路径上
  const posted = JSON.parse(noteCalls[0]!.body!) as { body: string };
  const local = readFileSync(join(outDir, `${event.id}.md`), 'utf8');
  assert.equal(posted.body, local);

  store.close();
});

test('写失败要如实报错，不能当成发成功了', async () => {
  const f = fakeFetch({ '/notes': { message: '403 Forbidden' } }, 403);

  const action = new GitLabCommentAction({
    api: api(),
    project: 'my-group/my-app',
    write: true,
    outDir,
  });

  const result = await withFetch(f.impl, () =>
    action.run(
      {
        event: {
          id: 'x',
          source: 'gitlab',
          project: 'p',
          mrIid: 7,
          title: 't',
          description: '',
          author: 'a',
          targetBranch: 'main',
          changedFiles: [],
          occurredAt: '2026-10-13T00:00:00.000Z',
        },
        verdicts: [
          {
            policyId: 'p',
            policyVersion: 'v',
            outcome: 'hit',
            reason: 'r',
            evidence: [],
          },
        ],
      },
      1,
    ),
  );

  assert.equal(result.ok, false);
  assert.ok(result.error?.includes('403'));
});
