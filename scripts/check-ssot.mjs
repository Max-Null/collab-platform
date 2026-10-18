#!/usr/bin/env node
/**
 * 单一事实源守卫（Single Source of Truth guard）。
 *
 * 防的是同一件事在多处各写一份、然后悄悄说不一样的话。当前守两条：
 *
 * ① **「?」的正文只能有一份** —— 事实源是 `public/console.html` 的 `TIPS`（那是
 *    实际显示给人看的那一份）。`docs/` 下的文档只许写「这一组要覆盖哪几点」，
 *    不许把正文抄回来。判据是「长度 ≥ 15 的连续子句」，短于这个长度会大量误报。
 *
 * ② **漫游引用的 TIPS key 必须存在** —— 少一个的话那一步会**静默地少掉最关键
 *    的口径说明**，看起来只是「这一步话比较少」，不报错、不空白，谁也不会去核对。
 *    （这条真发生过一次。）
 *
 * 有命中就非零退出，可直接接 CI 或提交前钩子。
 *
 * 用法：node scripts/check-ssot.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const root = process.cwd();
const CONSOLE = resolve(root, 'public/console.html');
const DOCS = resolve(root, 'docs');

/**
 * 从 HTML 里抽出 TIPS 的各条文案。
 *
 * ⚠️ 解析必须跟着 TIPS 的写法走，而**写法变了它不会自己知道**：
 * 曾经发生过一次 —— 文案从双引号单行改成单引号续接之后，下面的正则抽不到任何一条，
 * `tips` 成了 `{}`，于是「文档里有没有抄正文」这条检查**一条都没比过**，
 * 而输出仍然是「通过」。这正是这个仓库在防的那类失效，出现在它自己的守卫上。
 *
 * 所以有两条防线：解析器同时认两种引号（且支持 `+` 续接），
 * 以及**抽出 0 条本身就算失败** —— 一份控制台不可能没有「?」文案。
 */
function extractTips(html) {
  const block = /const TIPS = \{([\s\S]*?)\n\};/.exec(html);
  if (!block) return null;

  const body = block[1];
  const tips = {};

  // 每个 key 的正文从 "  <key>:" 起，到下一个同缩进的 key 或块尾
  const heads = [...body.matchAll(/^ {2}(\w+):/gm)];

  heads.forEach((m, i) => {
    const start = m.index + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    const chunk = body.slice(start, end);

    // 把这一段里的所有字符串字面量拼起来 —— 文案是分段 `+` 续接的，
    // 只取第一段会让检查漏掉后面那些（而后面那些正是长句所在）。
    const parts = [...chunk.matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2]);

    tips[m[1]] = parts.join('').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, '\n');
  });

  return tips;
}

/** 从 HTML 里抽出漫游引用的 tip key */
function extractTourTips(html) {
  const block = /const TOUR = \[([\s\S]*?)\n\];/.exec(html);
  if (!block) return [];

  const keys = [];
  const re = /tip:\s*'(\w+)'/g;
  let m;
  while ((m = re.exec(block[1])) !== null) keys.push(m[1]);
  return keys;
}

/** 一条文案里「够长、足以判定为抄写」的子句 */
function fragments(text) {
  return text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .split(/[。；，、！？\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);
}

/**
 * 豁免标记。**行级**，不是文件级。
 *
 * 为什么需要它：判据是「出现 ≥ 15 字符的子句就报」，于是两种**正当**写法
 * 会被误报：
 * - 在**讨论**某条文案的措辞（引用是必要的，不引用没法讨论）
 * - 在**引用**别处的文案说明它与本地不同
 *
 * 行级而不是文件级：一句话被引用不等于整个文件都豁免 ——
 * 文件级的豁免等于给这个文件开一张空白通行证，而通行证永远会被用满。
 */
const ALLOW = 'ssot-allow';

function walkMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkMarkdown(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

const html = readFileSync(CONSOLE, 'utf8');
const problems = [];

// ── ① 文档里不得出现「?」正文 ──────────────────────────
const tips = extractTips(html);
if (!tips) {
  problems.push(`从 ${relative(root, CONSOLE)} 里抽不出 TIPS —— 抽取规则要跟着改`);
} else if (Object.keys(tips).length === 0) {
  // 「抽出来是 0 条」不能算通过。控制台不可能一条「?」文案都没有 ——
  // 抽不到只有一种解释：解析规则跟写法脱节了，而它会安安静静地
  // 把两条检查（抄写、漫游引用）全部跳过，输出仍然是「通过」。
  problems.push(
    `从 ${relative(root, CONSOLE)} 里抽出了 **0 条** TIPS —— 解析规则与当前写法脱节了。\n` +
      `    → 这不是「没有文案」，是守卫在看别的地方。修 scripts/check-ssot.mjs 的 extractTips。`,
  );
} else {
  for (const file of walkMarkdown(DOCS)) {
    const lines = readFileSync(file, 'utf8').split('\n');

    for (const [key, text] of Object.entries(tips)) {
      for (const frag of fragments(text)) {
        lines.forEach((line, i) => {
          if (!line.includes(frag)) return;
          if (line.includes(ALLOW)) return; // 这一行声明了豁免

          problems.push(
            `${relative(root, file)}:${i + 1} 抄了 TIPS.${key} 的正文：「${frag.slice(0, 40)}…」\n` +
              `    → 「?」的正文只有一份（public/console.html 的 TIPS）。文档请改成只列要点；` +
              `确实需要引用原文的，在该行加 ${ALLOW} 说明理由。`,
          );
        });
      }
    }
  }
}

// ── ② 漫游引用的 key 必须存在 ──────────────────────────
if (tips) {
  for (const key of extractTourTips(html)) {
    if (!(key in tips)) {
      problems.push(
        `TOUR 引用了不存在的说明文案：${key}\n` +
          `    → 那一步会静默地少掉最关键的口径说明，看起来只是「话比较少」。`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`\n单一事实源守卫：发现 ${problems.length} 个问题\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}

console.log(
  `单一事实源守卫：通过（TIPS ${Object.keys(tips ?? {}).length} 条 · ` +
    `漫游引用 ${extractTourTips(html).length} 处 · 文档 ${walkMarkdown(DOCS).length} 份）`,
);
