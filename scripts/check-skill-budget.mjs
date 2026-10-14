import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 常驻税守卫：技能包不能长得太肥。
 *
 * 判据来自调研（行途那份 `INSIGHTS.md` 的实测）：
 *
 * | 项 | 预算 | 它治什么 |
 * |---|---|---|
 * | description | **< 200 字符** | **description 是常驻税**：装了技能，desc 每轮都在场 |
 * | 正文 | **< 200 行** | desc 触发之后，正文撑爆上下文 |
 *
 * 那句原话值得抄在这里：**「省 token 的工具若写法不当反而成为最大税源」** ——
 * 40 个技能全装实测约 7.1K token，是"按场景分包"的 4 倍。
 *
 * ⚠️ 这个预算**按字符算，而我们写的是中文**。中文一个字符约等于一个 token，
 * 英文一个字符约等于 1/4 个 token —— 所以同样 200 字符，中文的税是英文的四倍。
 * 上面那两个数是从中文技能库里实测出来的，所以对我们也适用（不必再打折）。
 */

const root = resolve(import.meta.dirname, '..');
const SKILLS = join(root, 'skills');

const DESC_BUDGET = 200;
const BODY_BUDGET = 200;

/**
 * 从 frontmatter 里取出 description。
 *
 * ⚠️ **顺序要紧：折叠/字面写法（`>` 或 `|`）必须排在单行匹配前面。**
 * 反过来的话，`description: >` 这一行本身会匹配单行规则、返回字符串 `">"` ——
 * 于是算出来是 **1 个字符**，一个写得越长的描述看起来越"省"。
 * 这个 bug 真出现过：写完守卫跑第一次，我们的技能报 `desc 1`。
 */
function extractDescription(frontmatter) {
  // ⚠️ 前瞻必须用 (?![\s\S]) 表示「真正的末尾」。写成 \n*$ 是错的：
  // `m` 模式下 `$` 匹配**每一行**的末尾，非贪婪匹配碰到的第一行就停了 ——
  // 于是多行描述只量到第一行，同样"看起来合规"。这两个 bug 都真出现过。
  const folded = /^description:\s*[>|]\s*\n([\s\S]*?)(?=\n\w+:|(?![\s\S]))/m.exec(frontmatter);
  if (folded) {
    return folded[1]
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ');
  }

  const inline = /^description:\s*(.+)$/m.exec(frontmatter);
  if (inline) return inline[1].trim();

  return null;
}

function walkSkillFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkSkillFiles(p));
    else if (name === 'SKILL.md') out.push(p);
  }
  return out;
}

const problems = [];
const files = walkSkillFiles(SKILLS);

for (const file of files) {
  const rel = relative(root, file);
  const raw = readFileSync(file, 'utf8');

  const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
  if (!fm) {
    problems.push(`${rel} 没有 frontmatter —— 它不会有 description，也就无法被触发`);
    continue;
  }

  const desc = extractDescription(fm[1]);
  if (desc === null) {
    problems.push(`${rel} 的 frontmatter 里没有 description`);
  } else if (desc.length > DESC_BUDGET) {
    problems.push(
      `${rel} 的 description ${desc.length} 字符 > ${DESC_BUDGET}\n` +
        `    → description 是**常驻税**：装了它，这段每轮都在场。把细节挪进正文，` +
        `desc 只留「什么时候用它」。`,
    );
  }

  // 正文行数 = 去掉 frontmatter 之后的行数
  const body = raw.slice(fm[0].length).split('\n').length;
  if (body > BODY_BUDGET) {
    problems.push(
      `${rel} 正文 ${body} 行 > ${BODY_BUDGET}\n` +
        `    → 超出部分下沉到 references/ 之类的地方按需加载，别让它常驻。`,
    );
  }
}

if (files.length === 0) {
  console.log('技能常驻税守卫：没有技能包要检查');
  process.exit(0);
}

if (problems.length > 0) {
  console.error(`\n技能常驻税守卫：发现 ${problems.length} 个问题\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

const detail = files
  .map((f) => {
    const raw = readFileSync(f, 'utf8');
    const fm = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    const desc = extractDescription(fm[1]) ?? '';
    const body = raw.slice(fm[0].length).split('\n').length;
    return `${relative(root, f)}（desc ${desc.length} · 正文 ${body} 行）`;
  })
  .join(' · ');

console.log(`技能常驻税守卫：通过（${files.length} 个技能 · ${detail}）`);
