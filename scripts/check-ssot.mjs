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

/** 从 HTML 里抽出 TIPS 的各条文案 */
function extractTips(html) {
  const block = /const TIPS = \{([\s\S]*?)\n\};/.exec(html);
  if (!block) return null;

  const tips = {};
  const re = /^\s{2}(\w+):\s*"((?:[^"\\]|\\.)*)"/gm;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    tips[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
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
