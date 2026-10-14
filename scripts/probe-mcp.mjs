/**
 * MCP 出口的真协议探针。
 *
 * 起的是**最终会被 DSH 启动的那一条命令**（默认 `<本机包装脚本>`），
 * 而不是 dist 里的 js —— 包装脚本里少一个环境变量、路径写错一个字符，
 * 只有走这条路才看得出来，而这恰好是最容易出错、也最难从现象反推的一层。
 *
 * 用法：node scripts/probe-mcp.mjs [command]
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const target = process.argv[2] ?? '<本机包装脚本>';

const child = spawn(target, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });

const pending = new Map();
let nextId = 1;
let stderrBuf = '';

createInterface({ input: child.stdout, terminal: false }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log(`⚠ stdout 里出现了不是 JSON 的一行：${line}`);
    return;
  }
  const settle = msg.id === undefined ? undefined : pending.get(msg.id);
  if (settle) {
    pending.delete(msg.id);
    settle(msg);
  }
});

createInterface({ input: child.stderr, terminal: false }).on('line', (line) => {
  stderrBuf += `${line}\n`;
});

function call(method, params) {
  return new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.delete(id)) rej(new Error(`${method} 超时（60s）`));
    }, 60_000);
    timer.unref();
    pending.set(id, (msg) => {
      clearTimeout(timer);
      res(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

const textOf = (res) => (res.result?.content ?? []).map((c) => c.text).join('\n');

try {
  const init = await call('initialize', { protocolVersion: '2024-11-05' });
  console.log(`[initialize] ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);

  const list = await call('tools/list');
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log(`[tools/list] ${names.length} 个：${names.join(', ')}`);

  const policies = await call('tools/call', { name: 'list_policies', arguments: {} });
  console.log(`\n[list_policies]\n${textOf(policies)}`);

  const guide = await call('tools/call', { name: 'get_usage_guide', arguments: {} });
  const guideText = textOf(guide);
  console.log(
    `\n[get_usage_guide] ${guideText.length} 字符 · 首行：${guideText.split('\n')[0]}`,
  );
  if (!guideText.includes('被检验的主张')) {
    throw new Error('使用指引里缺了「title 是主张不是依据」那一条');
  }

  const stats = await call('tools/call', { name: 'policy_stats', arguments: {} });
  console.log(`\n[policy_stats]\n${textOf(stats)}`);

  const submit = await call('tools/call', {
    name: 'submit_change',
    arguments: {
      project: 'my-group/my-app',
      mrIid: 900,
      title: '探针：修正几个错别字',
      description: '纯文案调整。',
      author: 'probe',
      changedFiles: ['src/LoginServiceImpl.java'],
      diff: '@@ -58,6 +58,10 @@\n+  // 顺手把锁定账号也放行\n+  if (user.getStatus() == 0) { return ApiResult.ok(buildLoginVO(user)); }',
      eventId: `probe-${Date.now()}`,
    },
  });
  console.log(`\n[submit_change]\n${textOf(submit)}`);

  console.log(`\n探针通过。stderr：\n${stderrBuf.trim()}`);
} catch (e) {
  console.error(`探针失败：${e.message}`);
  console.error(stderrBuf);
  process.exitCode = 1;
} finally {
  child.kill();
}
