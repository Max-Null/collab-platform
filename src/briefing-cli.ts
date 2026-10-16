import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { renderBriefing } from './briefing.js';
import { judgeDaemon } from './heartbeat.js';
import { wire } from './wiring.js';

/**
 * 简报入口：`npm run briefing`
 *
 * **默认只落本地文件，不碰网络。** 设计文档 §六 待决 2 给的默认值是「飞书通道、
 * 每天一条、写开关默认关；关着时只落本地文件不发出去」—— 所以这里没有发送代码：
 * 「要不要把这个平台说的话推到人面前」是另一件要单独决定的事，不该顺手做掉。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'var/platform.db' },
    out: { type: 'string', default: 'var/comments' },
    'out-dir': { type: 'string', default: 'var/briefings' },
  },
  allowPositionals: false,
});

const w = wire({ root, dbPath: resolve(root, values.db), outDir: resolve(root, values.out) });

const now = new Date();
const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
/** 报「最近出过事」用的窗口。7 天是个折中：短了盖不住周末，长了会把早已自愈的事翻出来。 */
const failureWindow = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();
const lastBeat = w.store.lastHeartbeat();
const lastJudgmentAt = w.store.lastJudgmentAt();

const text = renderBriefing({
  now,
  lastBeat,
  lastJudgmentAt,
  pending: w.store.listPendingReactions(200),
  errors: w.store.listUnresolvedErrors(200),
  stats: w.store.statsByPolicyVersion(),
  last24h: w.store.countSince(since),
  recentBeats: w.store.heartbeatsSince(failureWindow),
  // 探针结果跟着**最后一轮心跳**走：它回答的是「常驻最近一次探的时候，那个东西还在不在」。
  // 不单独存一份 —— 存两份就会有「哪份更新」的问题。
  probe: lastBeat?.probe,
});

if (!text) {
  // 没内容时也要说一句平台状态 —— 否则「今天没简报」与「简报坏了」分不开，
  // 而这两种情况要做的事完全不一样。
  const daemon = judgeDaemon({ last: lastBeat, lastJudgmentAt, now });
  console.log('今天没有要你决定的事 —— 按设计，**没内容就不发**（不发「今日无异常」这种填充物）。');
  console.log(`  平台：${daemon.note}`);
  console.log(`  ${daemon.lastJudgmentNote} · 过去 24 小时新判 ${w.store.countSince(since)} 条`);
  w.store.close();
  process.exit(0);
}

const dir = resolve(root, values['out-dir']);
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `${now.toISOString().slice(0, 10)}.md`);
writeFileSync(file, text, 'utf8');

process.stdout.write(text);
console.log(`\n→ 已落盘：${file}`);
console.log('  发不发出去是另一件要单独决定的事 —— 这条链路现在不碰网络。');

w.store.close();
