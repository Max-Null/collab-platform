import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { test } from 'node:test';

/**
 * MCP 出口的测试。
 *
 * **起的是真的子进程、走的是真的 stdio 协议**，不是把 handler 函数拿出来直接调。
 * 这么做的理由是这个出口最容易坏的地方在协议层而不在逻辑层：stdout 里混进一行
 * 日志、通知被当成请求回了响应、id 对不上 —— 这些在函数级测试里一个都测不出来，
 * 到了 DSH 里表现却都是「连接莫名断开」。
 */

const root = process.cwd();
const serverPath = resolve(root, 'dist/src/mcp/server.js');

interface Server {
  call: (method: string, params?: unknown) => Promise<Record<string, unknown>>;
  notify: (method: string, params?: unknown) => void;
  stop: () => void;
  stderr: () => string;
}

function startServer(env: Record<string, string> = {}): Server {
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', '--disable-warning=ExperimentalWarning', serverPath],
    {
      cwd: root,
      env: { ...process.env, COLLAB_DB: ':memory:', COLLAB_OUT: 'var/test-mcp', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;
  let stderrBuf = '';

  createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
    const msg = JSON.parse(line) as { id?: number };
    const settle = msg.id === undefined ? undefined : pending.get(msg.id);
    if (settle && msg.id !== undefined) {
      pending.delete(msg.id);
      settle(msg);
    }
  });

  createInterface({ input: child.stderr, terminal: false }).on('line', (line) => {
    stderrBuf += `${line}\n`;
  });

  const call = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((res, rej) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) rej(new Error(`${method} 超时（15s）`));
      }, 15_000);
      timer.unref();

      pending.set(id, (msg) => {
        clearTimeout(timer);
        res(msg);
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const notify = (method: string, params?: unknown): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  };

  return { call, notify, stop: () => child.kill(), stderr: () => stderrBuf };
}

async function callTool(
  s: Server,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; isError: boolean }> {
  const res = (await s.call('tools/call', { name, arguments: args })) as {
    result?: { content: { text: string }[]; isError?: boolean };
  };
  const content = res.result?.content ?? [];
  return { text: content.map((c) => c.text).join('\n'), isError: res.result?.isError === true };
}

const CHANGE = {
  project: 'my-group/my-app',
  mrIid: 901,
  title: '用户中心：修正几个错别字',
  description: '登录页提示文案有几处错别字，顺手改一下。',
  author: 'wangwu',
  targetBranch: 'main',
  changedFiles: ['src/LoginServiceImpl.java'],
  diff: '@@ -58,6 +58,11 @@\n+        if (user.getStatus() == 0) { return ApiResult.ok(buildLoginVO(user)); }',
};

test('协议：initialize 返回 serverInfo，tools/list 列出全部工具', async () => {
  const s = startServer();
  try {
    const init = (await s.call('initialize', { protocolVersion: '2024-11-05' })) as {
      result?: { serverInfo?: { name: string }; capabilities?: { tools?: unknown } };
    };
    assert.equal(init.result?.serverInfo?.name, 'collab-platform');
    assert.ok(init.result?.capabilities?.tools !== undefined);

    const list = (await s.call('tools/list')) as { result?: { tools: { name: string }[] } };
    const names = (list.result?.tools ?? []).map((t) => t.name);
    assert.deepEqual(names, [
      // 问管家：读的是同一份判断记录，说出来的是一段人话
      'ask_butler',
      'get_usage_guide',
      'list_judgments',
      'get_judgment',
      'policy_stats',
      'list_policies',
      'submit_change',
      'record_reaction',
    ]);
  } finally {
    s.stop();
  }
});

test('协议：通知不回响应，stdout 里不会混进日志', async () => {
  const s = startServer();
  try {
    s.notify('notifications/initialized');

    // 如果通知被当成请求回了响应，下面这次调用的响应就会跟它撞上 ——
    // 表现是拿到的 result 对不上，或者干脆超时
    const res = await s.call('ping');
    assert.deepEqual(res.result, {});

    assert.ok(s.stderr().includes('已启动'), '日志要走 stderr');
  } finally {
    s.stop();
  }
});

test('get_usage_guide：返回使用指引正文，且它讲的是用法不是工具清单', async () => {
  const s = startServer();
  try {
    const guide = await callTool(s, 'get_usage_guide');
    assert.equal(guide.isError, false);
    assert.ok(guide.text.includes('submit_change'), '要讲清什么时候该申报');
    assert.ok(guide.text.includes('record_reaction'), '要讲清三个反应取值的区别');
    assert.ok(
      guide.text.includes('被检验的主张'),
      '最容易写错的那条（title 是主张不是依据）必须在里面 —— 它是这份指引存在的主要理由',
    );
    assert.ok(
      guide.text.includes('以 tools/list 为准'),
      '指引只讲用法，不复制工具清单 —— 复制就是第二份事实源',
    );
  } finally {
    s.stop();
  }
});

test('未知方法报 -32601，未知工具不崩', async () => {
  const s = startServer();
  try {
    const bad = (await s.call('nope/nope')) as { error?: { code: number } };
    assert.equal(bad.error?.code, -32601);

    const tool = await callTool(s, 'nope_tool');
    assert.equal(tool.isError, true);
    assert.ok(tool.text.includes('未知工具'));
  } finally {
    s.stop();
  }
});

test('submit_change：跑完管道并把三条策略的结局都说清楚', async () => {
  const s = startServer();
  try {
    const r = await callTool(s, 'submit_change', CHANGE);
    assert.equal(r.isError, false);
    assert.ok(r.text.includes('review-sensitive-path'), '每条策略的结局都要列出来');
    assert.ok(r.text.includes('review-claim-mismatch'));
    assert.ok(r.text.includes('落判断记录 2 条'));

    // 没配模型时第二条策略落 error —— 出口必须如实说「不等于通过」，
    // 而不是让调用方以为「没提问题就是没问题」
    assert.ok(r.text.includes('判断没做成（不等于通过）'));
  } finally {
    s.stop();
  }
});

test('submit_change：缺必填字段时明确报错，不留一条半截记录', async () => {
  const s = startServer();
  try {
    const bad = await callTool(s, 'submit_change', { project: 'x', mrIid: 1, title: 't' });
    assert.equal(bad.isError, true);
    assert.ok(bad.text.includes('changedFiles'));

    const rows = await callTool(s, 'list_judgments');
    assert.ok(rows.text.includes('没有判断记录'), '校验没过就不该落任何记录');
  } finally {
    s.stop();
  }
});

test('list_judgments / get_judgment：记录能读回来，依据完整', async () => {
  const s = startServer();
  try {
    await callTool(s, 'submit_change', {
      ...CHANGE,
      changedFiles: ['db/migration/10_tables.sql', 'src/LoginServiceImpl.java'],
    });

    const list = await callTool(s, 'list_judgments');
    assert.ok(list.text.includes('review-sensitive-path'));
    assert.match(list.text, /#\d+ \[hit\] review-sensitive-path/);

    const id = Number(/#(\d+) \[hit\] review-sensitive-path/.exec(list.text)![1]);
    const one = await callTool(s, 'get_judgment', { judgmentId: id });
    assert.ok(one.text.includes('依据：'));
    assert.ok(one.text.includes('10_tables.sql'), '依据里要有具体文件');
    assert.ok(one.text.includes('**/*.sql'), '依据里要带上是哪条规则命中的');

    const missing = await callTool(s, 'get_judgment', { judgmentId: 99999 });
    assert.equal(missing.isError, true);
  } finally {
    s.stop();
  }
});

test('record_reaction：回写反应并留下「为什么」', async () => {
  const s = startServer();
  try {
    await callTool(s, 'submit_change', CHANGE);

    const list = await callTool(s, 'list_judgments');
    const id = Number(/#(\d+) \[error\] review-claim-mismatch/.exec(list.text)![1]);

    const done = await callTool(s, 'record_reaction', {
      judgmentId: id,
      reaction: 'rejected',
      note: '这次并没有改鉴权，模型看错了 diff',
    });
    assert.equal(done.isError, false);
    assert.ok(done.text.includes('进升级条件'), '明确否定要说明它会进升级条件');

    const after = await callTool(s, 'get_judgment', { judgmentId: id });
    assert.ok(after.text.includes('rejected'));
    assert.ok(after.text.includes('模型看错了 diff'), '「为什么」要留在库里');

    const bad = await callTool(s, 'record_reaction', { judgmentId: id, reaction: 'maybe' });
    assert.equal(bad.isError, true);
    assert.ok(bad.text.includes('adopted / rejected / ignored'));
  } finally {
    s.stop();
  }
});

test('policy_stats：观察期数据把「判断没做成」单列', async () => {
  const s = startServer();
  try {
    await callTool(s, 'submit_change', CHANGE);

    const stats = await callTool(s, 'policy_stats');
    assert.ok(stats.text.includes('review-sensitive-path'));
    assert.ok(stats.text.includes('判断没做成'));
    assert.ok(stats.text.includes('只有「明确否定」进升级条件'));
  } finally {
    s.stop();
  }
});
