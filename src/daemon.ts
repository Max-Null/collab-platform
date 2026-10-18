import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { GitHubPullSource } from './event/github.js';
import { GitHubPushSource } from './event/github-push.js';
import { GitLabPollSource } from './event/gitlab.js';
import { GitLabPushSource } from './event/gitlab-push.js';
import type { EventSource } from './event/source.js';
import { GitHubApi } from './github/api.js';
import { GitLabApi, fetchOAuthToken } from './gitlab/api.js';
import { runPipeline } from './pipeline.js';
import type { Heartbeat, ProbeResult } from './types.js';
import { wire } from './wiring.js';
import type { GitLabWiring } from './wiring.js';

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
    /**
     * 订阅哪种事件，逗号分隔：`mr`（合并请求）/ `push`（分支提交）。
     *
     * **默认 push**，理由不是「push 更好」，而是**它对应这个团队的实际形态**：
     * 三个仓库合计 3 条 MR 而提交是活跃的，工作方式是「功能分支直接推 test」。
     * 只订阅 MR 的平台上，每轮都成功、每轮都是 0 个事件 —— 而它自己看不出
     * 这与「真的没有变更」的区别。
     *
     * ⚠️ 两个都订阅时，MR 合并后的那些提交会**各自再报一次**（同一个变更判两遍），
     * 而观察期的分母最怕重复计数。团队开始走 MR 之后应当只留 `mr`。
     */
    source: { type: 'string', default: 'push' },
    /** push 源订阅哪个分支；不填则用仓库的默认分支 */
    branch: { type: 'string' },
    /**
     * 每轮顺手探一下这个地址，结果落进心跳（不填就不探）。
     *
     * 探的是**这套系统里自己没法自证的那部分**：控制台挂了，它报不出自己挂了。
     * 常驻是另一个进程，那一刻它还在 —— 于是「打不开」这件事才有可能被记下来，
     * 再由别的出口（简报、MCP）说出去。见 types.ts 的 Heartbeat.probe。
     */
    probe: { type: 'string' },
    /**
     * 盯哪个代码托管平台：`github` / `gitlab`。
     *
     * ⚠️ **必须显式给，不按环境变量猜。** 「哪个变量配了就猜哪个」在这里特别坏：
     * 两个平台的环境变量同时存在时（本地有 GitHub、公司有 GitLab），猜错的后果是
     * 常驻安安静静地盯着一个你以为它没在看的仓库 —— 而它每轮都成功、每轮 0 事件。
     * 这与「真的没有变更」长得一模一样，正是这个平台全篇在防的那类失效。
     */
    host: { type: 'string', default: 'gitlab' },
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

/**
 * 探一下那个地址还在不在。
 *
 * ⚠️ **任何 HTTP 状态码都算「通」。** 401 / 403 / 404 都说明服务在应答 ——
 * 而这里要回答的问题是「**它还在不在**」，不是「我有没有权限」。把 401 记成不通，
 * 就会每天报一次假警，而**天天响的告警与没有告警是一回事**。
 *
 * ⚠️ **不重试**：一轮轮询的预算有限，而且重试会把「偶尔抖一下」抹平 ——
 * 抖动也是事实，下一轮自会再探一次。
 */
async function probeOnce(url: string, timeoutMs = 5000): Promise<ProbeResult> {
  const started = Date.now();
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { url, ok: true, ms: Date.now() - started };
  } catch (e) {
    return { url, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 打时间戳的日志 —— 长跑进程里没有时间戳的日志等于没有日志 */
function log(msg: string): void {
  process.stdout.write(`${new Date().toISOString().slice(11, 19)}  ${msg}\n`);
}

async function main(): Promise<void> {
  const wanted = (values.source ?? 'push')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const sources: EventSource[] = [];
  let gitlabWiring: GitLabWiring | undefined;
  let hostNote: string;

  if (values.host === 'github') {
    const api = new GitHubApi({ token: need('GITHUB_TOKEN') });
    const project = need('GITHUB_PROJECT');

    if (wanted.includes('mr')) {
      sources.push(
        new GitHubPullSource(api, project, { limit: Number(values.limit), state: values.state }),
      );
    }
    if (wanted.includes('push')) {
      sources.push(
        new GitHubPushSource(api, project, { branch: values.branch, limit: Number(values.limit) }),
      );
    }
    hostNote = `github · ${project} · 只读（写开关还没接到 GitHub 上）`;
  } else if (values.host === 'gitlab') {
    const baseUrl = need('GITLAB_BASE_URL');
    const project = need('GITLAB_PROJECT');
    const write = process.env.GITLAB_WRITE === 'true';

    // 两种凭据形态，与 CLI 一致（PAT 优先，否则用户名密码换 OAuth 令牌）
    let api: GitLabApi;
    const pat = process.env.GITLAB_TOKEN;
    if (pat) {
      api = new GitLabApi({ baseUrl, token: pat });
    } else {
      const username = need('GITLAB_USER');
      const password = need('GITLAB_PASSWORD');
      const token = await fetchOAuthToken({ baseUrl, username, password });
      api = new GitLabApi({
        baseUrl,
        token,
        tokenKind: 'bearer',
        // 常驻要跑几天，而这条令牌两小时就过期 —— 让它自己在 401 时换一个（见 api.ts 的 req）
        refresh: () => fetchOAuthToken({ baseUrl, username, password }),
      });
    }

    if (wanted.includes('mr')) {
      sources.push(
        new GitLabPollSource(api, project, { limit: Number(values.limit), state: values.state }),
      );
    }
    if (wanted.includes('push')) {
      sources.push(
        new GitLabPushSource(api, project, { branch: values.branch, limit: Number(values.limit) }),
      );
    }
    gitlabWiring = { api, project, write };
    hostNote = `gitlab · ${project} · ${write ? '写开关【开】' : '写开关【关】（干燥跑，不发任何东西到 GitLab）'}`;
  } else {
    throw new Error(`--host 只能是 github 或 gitlab：${values.host}`);
  }

  if (sources.length === 0) {
    // 装配期就报错，不留到运行时空转 —— 一个「什么都没订阅」的常驻进程会
    // 每轮成功、每轮 0 事件，与「真的没有变更」长得一模一样。
    throw new Error(`--source 里没有认识的事件源：${values.source}（只能是 mr / push，逗号分隔）`);
  }

  // 装配与 CLI、MCP 出口共用一条路径 —— 三个入口给出不同结论才是真问题
  const w = wire({ root, dbPath, outDir, gitlab: gitlabWiring });

  const intervalMs = Math.max(30, Number(values.interval)) * 1000;
  let rounds = 0;
  let stopped = false;

  log(
    `[协作平台 · 常驻] ${hostNote} · 订阅 ${sources.map((s) => s.name).join(' + ')}` +
      `${values.branch ? ` @ ${values.branch}` : ''} · 每 ${intervalMs / 1000}s 一轮`,
  );
  log(
    `  策略 ${w.policies.length} 条 · 模型 ${
      w.llmConfigured ? `${w.llm.name}/${w.llm.model}` : '未配置（依赖模型的判据会落「判断没做成」）'
    } · 库 ${dbPath}`,
  );

  const tick = async (): Promise<void> => {
    rounds += 1;
    const started = Date.now();

    /**
     * 每轮都落一条心跳 —— 成功了记成绩，失败了记原因。
     *
     * 这是「看得见」那一层的入口：日志只活在终端里，终端一关就没了；
     * 心跳落在库里，控制台因此回答得出「它现在还在不在跑」。
     */
    const beat = (
      h: Omit<Heartbeat, 'at' | 'intervalMs' | 'durationMs' | 'model' | 'modelConfigured'>,
    ): void => {
      w.store.saveHeartbeat({
        at: new Date().toISOString(),
        intervalMs,
        durationMs: Date.now() - started,
        // 模型信息跟着心跳走：控制台是**另一个进程**，它自己的环境里往往没有
        // 模型配置 —— 界面拿自己的配置去说「平台没配模型」是在报一个不存在的问题。
        model: w.llmConfigured ? w.llm.model : w.llm.name,
        modelConfigured: w.llmConfigured,
        ...h,
      });
    };

    // 顺手探一下那个地址（配了才探）。
    //
    // ⚠️ 探不通**不算这一轮失败**：探针回答的是「另一个东西还在不在」，
    // 与「这一轮拉事件、判事件」是两件事。混在一起会让心跳的 ok 失去意义 ——
    // 到那时「这一轮失败了」既可能是 GitLab 拉不到，也可能是控制台打不开，
    // 而这两件事要做的事完全不同。
    const probe = values.probe ? await probeOnce(values.probe) : undefined;

    try {
      // 多个源各自拉，合成一批。
      //
      // 一个源失败就让整轮失败（下一轮继续）—— 第一版不做「部分成功」：
      // 「push 源看到了、MR 源没看到」这件事要能落进记录才值得做，
      // 而那需要新字段，否则它就是一个只在日志里存在、事后查不到的中间状态。
      const batches = await Promise.all(sources.map((s) => s.fetch()));
      const events = batches.flat();

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
      beat({ ok: true, events: events.length, judged, skipped, probe });
    } catch (e) {
      // 一轮失败不让进程死。见文件头 ①。
      const msg = e instanceof Error ? e.message : String(e);
      log(`第 ${rounds} 轮失败（下一轮继续）：${msg}`);
      // 失败也落心跳：不落的话，「这一轮挂了」与「这一轮没有新事件」在库里长得一样
      beat({ ok: false, events: 0, judged: 0, skipped: 0, error: msg, probe });
    }

    // 探不通就当场喊一句。库里记着是一回事，日志里看得见是另一回事 ——
    // 长跑进程的日志是排查时第一个被翻的东西。
    if (probe && !probe.ok) log(`    探针：${probe.url} 不通 —— ${probe.error ?? '没给原因'}`);
  };

  await tick();
  if (values.once) {
    w.store.close();
    return;
  }

  // 上一轮还没跑完，就不要再开一轮。
  //
  // 没有这道闸时，一轮的耗时一旦超过间隔就会**并发**跑起来 —— 而模型慢一次就够了
  // （这台机器上 qwen3.6-plus 思考模式判一条 ~18s，几个事件就能超过 300s 的间隔）。
  // 并发轮次会互相拉长彼此，几轮之后变成雪崩，而**从外面看只是「越来越慢」**：
  // 心跳照常在写、日志照常在打，没有一行报错。
  let running = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (running) {
      log(`上一轮还在跑（超过 ${intervalMs / 1000}s），这一轮跳过 —— 免得轮次叠起来互相拖慢`);
      return;
    }
    running = true;
    void tick().finally(() => {
      running = false;
    });
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
