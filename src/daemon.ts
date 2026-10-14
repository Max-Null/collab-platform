import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitLabPollSource } from './event/gitlab.js';
import type { EventSource } from './event/source.js';
import { GitLabApi, fetchOAuthToken } from './gitlab/api.js';
import { runPipeline } from './pipeline.js';
import { wire } from './wiring.js';

/**
 * 常驻轮询：让平台在没人敲命令的时候也在跑。
 *
 * 为什么需要它 —— 它是「闸门」这个概念能不能成立的前提：
 * **一个要人手动触发的闸门等于没有闸门**。手工跑一次的那种用法，
 * 只能验证代码对不对，不能算平台在工作。
 *
 * 三条刻意的设计：
 *
 * ① **一轮失败不让进程死。** GitLab 抖一下、模型超时一次，下一轮继续。
 *    一个跑着跑着悄悄死掉的守护进程，比没有守护进程更坏 ——
 *    它的失效形态正是这个平台在防的那一类：**看起来在跑，其实早就不跑了**。
 *    所以每一轮都留痕（见 ③），而且进程每隔一段时间说一句「我还活着」。
 *
 * ② **写开关与它无关，单独由 GITLAB_WRITE 决定**，默认关。
 *    常驻只解决「什么时候看」，不解决「要不要说话」。在真仓库上开写，
 *    应该是另一件要单独决定的事。
 *
 * ③ **每轮的事件数与判过多少条都打出来。** 否则「没有输出」同时意味着
 *    「这轮没有新变更」和「这轮挂了」—— 又一处静默失效。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();

const { values } = parseArgs({
  options: {
    interval: { type: 'string', default: '300' }, // 秒
    db: { type: 'string', default: 'var/platform.db' },
    out: { type: 'string', default: 'var/comments' },
    limit: { type: 'string', default: '20' },
    state: { type: 'string', default: 'opened' },
    once: { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const dbPath = values.db === ':memory:' ? ':memory:' : resolve(root, values.db);
const outDir = resolve(root, values.out);

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`常驻跑真实事件源时必须配环境变量 ${name}`);
  return v;
}

/** 打时间戳的日志 —— 长跑进程里没有时间戳的日志等于没有日志 */
function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${msg}\n`);
}

async function main(): Promise<void> {
  const baseUrl = need('GITLAB_BASE_URL');
  const project = need('GITLAB_PROJECT');
  const write = process.env.GITLAB_WRITE === 'true';

  // 两种凭据形态，与 CLI 一致（PAT 优先，否则用户名密码换 OAuth 令牌）
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

  const source: EventSource = new GitLabPollSource(api, project, {
    limit: Number(values.limit),
    state: values.state,
  });

  // 装配与 CLI、MCP 出口共用一条路径 —— 三个入口给出不同结论才是真问题
  const w = wire({ root, dbPath, outDir, gitlab: { api, project, write } });

  const intervalMs = Math.max(30, Number(values.interval)) * 1000;
  let rounds = 0;
  let stopped = false;

  log(
    `[协作平台 · 常驻] ${project} · state=${values.state} · 每 ${intervalMs / 1000}s 一轮 · ` +
      `${write ? '写开关【开】' : '写开关【关】（干燥跑，不发任何东西到 GitLab）'}`,
  );
  log(
    `  策略 ${w.policies.length} 条 · 模型 ${
      w.llmConfigured ? `${w.llm.name}/${w.llm.model}` : '未配置（依赖模型的判据会落「判断没做成」）'
    } · 库 ${dbPath}`,
  );

  const tick = async (): Promise<void> => {
    rounds += 1;
    const started = Date.now();

    try {
      const events = await source.fetch();

      let judged = 0;
      let skipped = 0;
      for (const event of events) {
        const result = await runPipeline(event, {
          policies: w.policies,
          actions: w.actions,
          store: w.store,
          log: (m) => log(`    ${m}`),
        });

        // recorded > 0 说明这次真的判了；否则是幂等跳过（事件 id 带 sha）
        if (result.recorded > 0) {
          judged += 1;
          for (const v of result.verdicts) {
            const tag =
              v.outcome === 'hit' ? '命中' : v.outcome === 'miss' ? '未命中' : '判断没做成';
            log(`    ${event.id} · ${v.policyId} @ ${v.policyVersion} → ${tag}`);
            if (v.outcome === 'hit' && v.reason) log(`      ${v.reason}`);
          }
        } else {
          skipped += 1;
        }
      }

      const ms = Date.now() - started;
      // 每轮都打，哪怕什么都没发生 —— 「没有输出」不该同时意味着两件事
      log(
        `第 ${rounds} 轮：拉到 ${events.length} 个事件 · 新判 ${judged} · 跳过 ${skipped}（已判过）· ${ms}ms`,
      );
    } catch (e) {
      // 一轮失败不让进程死。见文件头 ①。
      log(`第 ${rounds} 轮失败（下一轮继续）：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await tick();
  if (values.once) {
    w.store.close();
    return;
  }

  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, intervalMs);

  const shutdown = (sig: string): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    log(`收到 ${sig}，收工。共跑 ${rounds} 轮。`);
    w.store.close();
    process.exit(0);
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => shutdown(sig));
}

main().catch((e) => {
  process.stderr.write(`启动失败：${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
