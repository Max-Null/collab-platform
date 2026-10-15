import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitLabHoldMergeAction } from '../src/action/hold-merge.js';
import type { ChangeEvent, PolicyVerdict } from '../src/types.js';

/**
 * 这一组测的核心只有一件事：**「拦不住」必须被说出来**。
 *
 * 自建 GitLab 是社区版，Blocking merge requests 用不了（实测 15.7.2，
 * `/blocks` 返回 404）—— 所以「拦」落在分支保护的合并权限上。
 * 评论发了、标记打了，而如果那个仓库还是谁都能合，**这次拦截就没发生**。
 * 那种「看起来做了」正是平台存在的理由要防的东西。
 */

const event: ChangeEvent = {
  id: 'gitlab-demo-7-abc123',
  source: 'gitlab',
  kind: 'mr',
  project: 'g/p',
  mrIid: 7,
  author: 'someone',
  targetBranch: 'main',
  changedFiles: ['a.ts'],
  title: 't',
  description: 'd',
  occurredAt: '2026-10-14T12:00:00.000Z',
};

const verdicts: PolicyVerdict[] = [
  {
    policyId: 'p1',
    policyVersion: 'v1',
    outcome: 'hit',
    reason: '动了鉴权逻辑',
    evidence: [{ kind: 'changed_file', detail: '鉴权模块', ref: 'a.ts' }],
  },
];

/** 一个只实现被用到的那几个方法的假 API —— 顺便让「动作到底调了什么」看得见 */
function fakeApi(over: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const base = {
    getProtectedBranches: async () => [
      { name: 'main', merge_access_levels: [{ access_level: 0, access_level_description: 'No one' }] },
    ],
    listLabels: async () => ['GM:挂起'],
    createLabel: async () => {
      calls.push('createLabel');
      return {};
    },
    getMergeRequest: async () => ({ iid: 7, labels: [] }),
    setLabels: async (_p: string, _i: number, labels: string[]) => {
      calls.push(`setLabels:${labels.join(',')}`);
      return {};
    },
    createNote: async () => {
      calls.push('createNote');
      return { id: 4321 };
    },
    ...over,
  };
  return { api: base as never, calls };
}

const action = (api: unknown, write = true) =>
  new GitLabHoldMergeAction({ api: api as never, project: 'g/p', write, outDir: 'var/test-hold' });

test('拦得住：受保护分支的 Allowed to merge 是 No one，不报 warning', async () => {
  const { api, calls } = fakeApi();
  const r = await action(api).run({ event, verdicts });

  assert.equal(r.ok, true);
  assert.equal(r.warning, undefined, '这个仓库里除了有权限的人，谁都不能合 —— 拦得住');
  assert.equal(r.externalRef, '4321', '记下 note id 供回滚');
  assert.ok(calls.includes('setLabels:GM:挂起'), '挂起标记是整体设置，不是追加');
  assert.ok(calls.includes('createNote'), '要发评论');
});

test('⚠️ 拦不住：Allowed to merge 是 Maintainers —— 必须说出来', async () => {
  const { api } = fakeApi({
    getProtectedBranches: async () => [
      {
        name: 'main',
        merge_access_levels: [{ access_level: 40, access_level_description: 'Maintainers' }],
      },
    ],
  });

  const r = await action(api).run({ event, verdicts });

  assert.equal(r.ok, true, '动作本身做成了 —— 说失败是撒谎');
  assert.ok(r.warning, '但必须带上警告，否则就是新的静默失效');
  assert.ok(r.warning!.includes('Maintainers'), '要说清是谁能绕过');
  assert.ok(r.warning!.includes('拦不住'), '要说清后果');
  assert.ok(r.output!.includes('标记'), '正文照常渲染');
});

test('目标分支根本没有保护 —— 谁都能直推，同样要说出来', async () => {
  const { api } = fakeApi({ getProtectedBranches: async () => [] });
  const r = await action(api).run({ event, verdicts });

  assert.equal(r.ok, true);
  assert.ok(r.warning!.includes('没有受保护'));
});

test('查不到保护配置 ≠ 拦得住 —— 如实说查不到', async () => {
  const { api } = fakeApi({
    getProtectedBranches: async () => {
      throw new Error('403 Forbidden');
    },
  });

  const r = await action(api).run({ event, verdicts });

  assert.equal(r.ok, true, '查不到配置不该让动作失败（它会漏掉后面该做的事）');
  assert.ok(r.warning, '但也不能当成拦得住');
  assert.ok(r.warning!.includes('查不到'), '说清是「不知道」而不是「能拦」');
});

test('干燥跑：不调任何写接口，但正文照常渲染并落文件', async () => {
  const { api, calls } = fakeApi();
  const r = await action(api, false).run({ event, verdicts });

  assert.equal(r.ok, true);
  assert.deepEqual(calls, [], '干燥跑不该碰任何写接口');
  assert.ok(r.output!.includes('干燥跑'));
  assert.ok(r.output!.includes('GM：这次变更暂不放行'), '正文与真发时是同一份');
});

test('label 不存在时先创建 —— 否则打标记会失败，而失败的动作等于没拦', async () => {
  const { api, calls } = fakeApi({ listLabels: async () => ['别的标签'] });
  await action(api).run({ event, verdicts });

  assert.ok(calls.includes('createLabel'), '先建再打');
  assert.ok(
    calls.indexOf('createLabel') < calls.findIndex((c) => c.startsWith('setLabels')),
    '顺序要对：不存在的 label 打不上去',
  );
});

test('没有 MR 编号的事件（比如 mock 源）→ 如实报错，不猜', async () => {
  const { api } = fakeApi();
  const r = await action(api).run({
    event: { ...event, mrIid: undefined as unknown as number },
    verdicts,
  });

  assert.equal(r.ok, false);
  assert.ok(r.error!.includes('没有 MR 编号'));
});
