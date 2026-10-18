import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubApi } from '../src/github/api.js';
import type { GitHubConfig } from '../src/github/api.js';
import { GitHubPullSource } from '../src/event/github.js';
import { GitHubPushSource } from '../src/event/github-push.js';

/**
 * GitHub 事件源。
 *
 * 这一层最容易出的错是**安静的错**：少一个 `User-Agent` 得到 403，
 * 漏一个 `patch` 得到「看起来什么都没改」，跳过合并提交时多跳一条得到
 * 「这处变更从没被看过」。所以下面测的多半不是「能拉到」，而是**拉到的形状对不对**。
 */

/** 一个只会按路线返回预设响应的假 fetch —— 不联网 */
function fakeFetch(routes: Record<string, unknown>): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });

    // 直接返回预设的那个值 —— `req()` 把 body 当数据用。多包一层的话，
    // 事件源拿到的是一个不是数组的东西，而报错会指向 `for...of`，离真正的原因很远。
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const cfg = (token = 't0ken'): GitHubConfig => ({ token, baseUrl: 'https://api.example.test' });

/* ── 头部 ─────────────────────────────────────────────────── */

test('GitHub 的请求必须带 User-Agent —— 缺了它回 403，而 403 读起来像「没权限」', async () => {
  const { fetch: f } = fakeFetch({ '/repos/o/r': { full_name: 'o/r' } });
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const api = new GitHubApi(cfg());
    await api.getRepo('o/r');
  } finally {
    globalThis.fetch = real;
  }

  // 从记录到的头里确认 —— fakeFetch 把 headers 回显了，但我们直接查调用更稳
  const { fetch: f2 } = fakeFetch({ '/repos/o/r': {} });
  let sent: Record<string, string> = {};
  globalThis.fetch = (async (_i: string | URL | Request, init?: RequestInit) => {
    sent = (init?.headers ?? {}) as Record<string, string>;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    await new GitHubApi(cfg()).getRepo('o/r');
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(sent['user-agent'], 'collab-platform', '少了这个头 GitHub 直接 403');
  assert.equal(sent.authorization, 'Bearer t0ken');
  assert.ok(sent.accept?.includes('application/vnd.github'));
});

/* ── 取数的形状 ───────────────────────────────────────────── */

test('patch 缺席的文件不伪装成空改动 —— 要写出「它没给」，不是「一行没改」', () => {
  // shapeFiles 是私有的，通过 fetchChanges 间接测
  const api = new GitHubApi(cfg());
  const shaped = (api as unknown as {
    shapeFiles: (f: unknown[]) => { changedFiles: string[]; diff: string };
  }).shapeFiles([
    { filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'big.bin', status: 'added' }, // 没有 patch
    { filename: 'new.ts', status: 'renamed', previous_filename: 'old.ts', patch: '@@' },
  ]);

  assert.deepEqual(shaped.changedFiles, ['a.ts', 'big.bin', 'old.ts → new.ts'], '重命名要记下原名');
  assert.match(shaped.diff, /\+y/, '有 patch 的要拼进 diff');
  assert.match(shaped.diff, /GitHub 没有为这个文件提供 patch/, '没有 patch 要明说，不能留白');
});

test('PR 事件：主张来自 title + body，body 为空也是主张（短而已）', async () => {
  const { fetch: f } = fakeFetch({
    '/pulls?': [
      {
        number: 7,
        title: 'feat: 加个配置',
        body: null,
        state: 'open',
        user: { login: 'zhang' },
        head: { ref: 'feat/x', sha: 'abcdef1234567890' },
        base: { ref: 'main' },
        updated_at: '2026-10-18T01:00:00Z',
      },
    ],
    '/files': [{ filename: 'a.yml', status: 'modified', patch: '@@' }],
  });
  const real = globalThis.fetch;
  globalThis.fetch = f;
  let events;
  try {
    events = await new GitHubPullSource(new GitHubApi(cfg()), 'o/r', { limit: 5 }).fetch();
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.kind, 'mr');
  assert.equal(e.mrIid, 7);
  assert.equal(e.title, 'feat: 加个配置');
  assert.equal(e.description, '', 'null 的 body 收成空串，不是 "null"');
  assert.equal(e.author, 'zhang');
  assert.equal(e.targetBranch, 'main');
  // 事件 id 带 sha：同一个 PR 改一版就是一次新事件
  assert.match(e.id, /pr-7-abcdef12$/, 'id 要带 head sha 的短版本');
});

test('推送事件：合并提交要跳过 —— 不跳的话同一处变更会判两遍', async () => {
  const { fetch: f } = fakeFetch({
    '/commits?': [
      {
        sha: 'aaa111',
        commit: { message: 'feat: 正常提交\n\n正文说明', author: { name: 'li', date: '2026-10-18T01:00:00Z' } },
        parents: [{ sha: 'p1' }],
      },
      {
        sha: 'bbb222',
        commit: { message: "Merge branch 'x'", author: { name: 'li', date: '2026-10-18T02:00:00Z' } },
        parents: [{ sha: 'p1' }, { sha: 'p2' }], // 合并提交
      },
    ],
    '/commits/': { files: [{ filename: 'a.ts', status: 'modified', patch: '@@' }] },
  });
  const real = globalThis.fetch;
  globalThis.fetch = f;
  let events;
  try {
    events = await new GitHubPushSource(new GitHubApi(cfg()), 'o/r', { limit: 10 }).fetch();
  } finally {
    globalThis.fetch = real;
  }

  assert.equal(events.length, 1, '合并提交必须被跳过');
  assert.equal(events[0]!.sha, 'aaa111');
});

test('推送事件：标题取第一行，描述取其余 —— 第一行照搬会让判据把同一句读两遍', async () => {
  const { fetch: f } = fakeFetch({
    '/commits?': [
      {
        sha: 'ccc333',
        commit: {
          message: 'feat: 一句话标题\n\n这里是正文\n还有第二行',
          author: { name: 'wang', date: '2026-10-18T03:00:00Z' },
        },
        parents: [{ sha: 'p1' }],
      },
    ],
    '/commits/': { files: [] },
  });
  const real = globalThis.fetch;
  globalThis.fetch = f;
  let events;
  try {
    events = await new GitHubPushSource(new GitHubApi(cfg()), 'o/r', { limit: 10 }).fetch();
  } finally {
    globalThis.fetch = real;
  }

  const e = events[0]!;
  assert.equal(e.title, 'feat: 一句话标题');
  assert.equal(e.description, '这里是正文\n还有第二行');
  assert.ok(!e.description.includes(e.title), '描述里不该再出现标题');
});

test('推送事件的事件 id 用完整 sha —— 短 sha 撞上，这次的判定会被当成上次的悄悄跳过', async () => {
  const { fetch: f } = fakeFetch({
    '/commits?': [
      {
        sha: '0123456789abcdef0123456789abcdef01234567',
        commit: { message: 'x', author: { name: 'a', date: '2026-10-18T00:00:00Z' } },
        parents: [{ sha: 'p' }],
      },
    ],
    '/commits/': { files: [] },
  });
  const real = globalThis.fetch;
  globalThis.fetch = f;
  let events;
  try {
    events = await new GitHubPushSource(new GitHubApi(cfg()), 'o/r', { limit: 1 }).fetch();
  } finally {
    globalThis.fetch = real;
  }

  assert.ok(events[0]!.id.includes('0123456789abcdef0123456789abcdef01234567'), '完整 sha 才不碰撞');
});

test('取数失败时如实抛错，不返回「空改动」—— 那看起来像一次干净的提交', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(
      () => new GitHubApi(cfg()).fetchChanges('o/r', 1),
      /HTTP 500/,
      '取数失败必须抛，让调用方落 error',
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('仓库标识写错在装配期就报 —— 不要等到发请求时才拿到一个 404', () => {
  assert.throws(() => new GitHubApi(cfg()).getRepo('no-slash'), /owner\/repo/);
});
