#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildOverview } from '../dist/src/console/overview.js';
import { wire } from '../dist/src/wiring.js';

/**
 * 把「设计链路」与「此刻状态」合成一张活点地图。
 *
 * 做法是**注入而不是重画**：archify 产出的那张图已经把几何、配色、交互都调好了，
 * 这一层只在节点上打标。所以图重新生成之后重跑一次这个脚本即可 ——
 * 注入的内容不写回源图，源图始终是「纯粹的设计图」。
 *
 * 生成出来的**一份 HTML 支持两种打开方式**：
 * - 从控制台打开（`/diagram`，同源）：页面 fetch `/api/overview`，看的是**此刻**。
 * - 双击打开（`file://`）：用这里**烤进去**的状态，看的是**生成那一刻的快照**，
 *   页面顶部会写明快照时刻 —— 不然一份昨天的快照与「现在」长得一模一样。
 *
 * 为什么状态要在这里读库、而不是让静态页面自己去拉：`file://` 下 fetch 会被浏览器
 * 挡掉，而挡掉的表现恰好是「图上什么标记都没有」，与「一切正常」一模一样。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();

const { values } = parseArgs({
  options: {
    src: { type: 'string' },
    dir: { type: 'string', default: 'docs/report' },
    out: { type: 'string', default: 'var/diagram/live.html' },
    db: { type: 'string', default: 'var/platform.db' },
    out2: { type: 'string', default: 'var/comments' },
  },
  allowPositionals: false,
});

/** 没给 --src 时，取 `--dir` 下最新的那张控制流图（按名字排，日期在最后） */
function findSource(dir) {
  const abs = resolve(root, dir);
  const names = readdirSync(abs)
    .filter((n) => n.startsWith('控制流-') && n.endsWith('.html'))
    .sort();
  const last = names[names.length - 1];
  if (!last) {
    throw new Error(
      `在 ${dir} 里没找到控制流图（找的是 控制流-*.html）。` +
        '先用 archify 生成一张：node <archify>/bin/archify.mjs finalize workflow <candidate.json> <out.html>',
    );
  }
  return join(abs, last);
}

const src = values.src ? resolve(root, values.src) : findSource(values.dir);
const out = resolve(root, values.out);
const dbPath = resolve(root, values.db);

const html = readFileSync(src, 'utf8');

// 注入前先确认这真是一张 archify 图：认节点靠的正是 data-node-id，没有它整层都落空，
// 而落空的表现同样是「图上什么都没有」。
if (!html.includes('data-node-id=')) {
  throw new Error(
    `${src} 里没有 data-node-id —— 它不是 archify 产出的 workflow 图，注入上去也标不到节点。`,
  );
}
if (html.includes('id="live-overlay"')) {
  throw new Error(`${src} 已经注入过了。请对 archify 的原始产物注入，别对注入过的再注入一次。`);
}

// —— 读库，取这一刻的状态 ——
// 用与 /api/overview 完全相同的组装函数：两处各写一遍的话，
// 界面上的数字与图上的标记迟早会对不上，而那种不一致不会报错。
const w = wire({ root, dbPath, outDir: resolve(root, values.out2) });
const state = { ...buildOverview(w, dbPath), at: new Date().toISOString() };
w.store.close();

const overlay = readFileSync(resolve(root, 'scripts/live-overlay.js'), 'utf8');

// `<` 转成 \u003c：JSON 里万一出现 </script> 会把标签提前闭合
const baked = JSON.stringify(state).replace(/</g, '\\u003c');
const tag =
  `<script id="live-state">window.__LIVE_STATE__ = ${baked};</script>\n` +
  `<script id="live-overlay">\n${overlay}\n</script>\n`;

const at = html.lastIndexOf('</body>');
if (at < 0) throw new Error(`${src} 里没有 </body>，不知道该往哪注入。`);
const merged = html.slice(0, at) + tag + html.slice(at);

mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, merged, 'utf8');

const kb = (p) => (statSync(p).size / 1024).toFixed(0) + ' KB';
const rel = (p) => p.replace(root + '\\', '');
console.log('活点地图已生成');
console.log(`  源图：${rel(src)}（${kb(src)}）`);
console.log(`  状态：烤入了 ${rel(dbPath)} 此刻的快照（${state.daemon?.status ?? '?'}）`);
console.log(`  输出：${rel(out)}（${kb(out)}）`);
console.log('');
console.log('  两种打开方式，同一份文件：');
console.log('    · 双击打开 —— 看烤进去的那份快照，页头会写明快照时刻');
console.log('    · 控制台 /diagram —— 实时拉，看的是此刻');
