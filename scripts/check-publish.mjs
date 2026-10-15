#!/usr/bin/env node
/**
 * 发布前置检查（本地 public → 公开仓）。
 *
 * 防的是**内容扫干净了、元数据带出去了**。README 那条流程的第 ① 步用 `git grep`
 * 扫工作区里的内容，而提交的**作者与提交者邮箱不在工作区里** —— 它是 `git commit`
 * 那一刻从 git 配置里取出来的元数据，所以那一步永远扫不到它。这里扫的就是它。
 *
 * 三条检查，任意一条不过就非零退出：
 *
 * ① **待发布提交的身份** —— `origin/main..public` 上每个提交的作者与提交者邮箱，
 *    必须在 `config/publish-identity.json` 的允许列表里。
 * ② **public 与远端对齐** —— 落后远端时 `push origin public:main` 会被判非快进、
 *    原样退回。树再对也没用，**push 比的是历史**。
 * ③ **当前 git 身份**（警告，不阻断）—— 它会写进**下一次** commit，所以拿它跟
 *    允许列表比一遍，能在那次 commit 发生之前就看见问题。
 *
 * 用法：node scripts/check-publish.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const LOCAL = 'refs/heads/public';
const REMOTE = 'origin/main';
const CONFIG = resolve(root, 'config/publish-identity.json');

/** 跑一条 git 命令。失败返回 null —— 这里要的是「报出来」，不是崩掉。 */
function git(...args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const problems = [];
const warnings = [];

// ── 允许的身份 ────────────────────────────────────────────────────────
let allowed = [];
try {
  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
  allowed = (cfg.allowedEmails ?? []).map((s) => String(s).toLowerCase());
} catch (e) {
  console.log(`✗ 读不到 ${CONFIG}：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
if (allowed.length === 0) {
  console.log('✗ config/publish-identity.json 的 allowedEmails 是空的 —— 空列表会让下面每条提交都不过');
  process.exit(1);
}

// ── ① 待发布提交的身份 ────────────────────────────────────────────────
// \x1f 是单元分隔符：提交标题里出现它的概率可以忽略，用它比用 | 稳。
const SEP = '\x1f';
const raw = git('log', `--format=%h${SEP}%an${SEP}%ae${SEP}%cn${SEP}%ce${SEP}%s`, `${REMOTE}..${LOCAL}`);

let commits = [];
if (raw === null) {
  problems.push(
    `读不到 ${REMOTE}..${LOCAL} —— 远端引用不存在，或者本地没有 public 分支。先 git fetch origin`,
  );
} else if (raw !== '') {
  commits = raw.split('\n').map((line) => {
    const [hash, an, ae, cn, ce, subject] = line.split(SEP);
    return { hash, an, ae, cn, ce, subject: subject ?? '' };
  });
}

for (const c of commits) {
  const bad = [];
  if (!allowed.includes(c.ae.toLowerCase())) bad.push(`作者 ${c.an} <${c.ae}>`);
  if (!allowed.includes(c.ce.toLowerCase())) bad.push(`提交者 ${c.cn} <${c.ce}>`);
  if (bad.length > 0) {
    problems.push(
      `${c.hash} ${c.subject.slice(0, 50)}\n` +
        `      → 不在允许列表：${bad.join('、')}\n` +
        `      → 这个提交要重做：git -c user.name='<公开名>' -c user.email='<公开邮箱>' commit --amend`,
    );
  }
}

// ── ② public 与远端对齐 ───────────────────────────────────────────────
const behind = git('rev-list', '--count', `${LOCAL}..${REMOTE}`);
if (behind !== null && Number(behind) > 0) {
  problems.push(
    `public 落后 ${REMOTE} ${behind} 条 —— 现在 push 会被判非快进、原样退回\n` +
      `      → git checkout public && git pull --ff-only origin main`,
  );
}

// ── ③ 当前 git 身份（警告）────────────────────────────────────────────
const email = git('config', '--get', 'user.email') ?? '';
const name = git('config', '--get', 'user.name') ?? '';
if (email !== '' && !allowed.includes(email.toLowerCase())) {
  warnings.push(
    `当前 git 身份 ${name} <${email}> 不在允许列表里。\n` +
      `      它会被写进**下一次** commit —— 所以覆盖那一步必须用 -c 显式给身份。`,
  );
}

// ── 输出 ──────────────────────────────────────────────────────────────
console.log('发布前置检查（public → 公开仓）');
console.log(`  允许的邮箱：${allowed.join('、')}`);
console.log('');

console.log(`  待发布提交（${REMOTE}..${LOCAL}）：${commits.length} 条`);
for (const c of commits) console.log(`    ${c.hash}  ${c.subject.slice(0, 60)}`);
if (commits.length === 0) {
  console.log('    —— 空：覆盖那一步还没做，或者树与远端已经一致');
}

if (warnings.length > 0 || problems.length > 0) console.log('');
for (const w of warnings) console.log(`  ⚠️ ${w}`);
for (const p of problems) console.log(`  ✗ ${p}`);

if (problems.length > 0) {
  console.log(`\n${problems.length} 条不过 —— 先别 push。`);
  process.exit(1);
}
console.log('\n都过了。下一步：git push origin public:main');
