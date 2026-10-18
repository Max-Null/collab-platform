import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ask } from './butler/ask.js';
import { brief } from './butler/brief.js';
import type { Period } from './butler/brief.js';
import { defaultChannels, deliver } from './butler/channel.js';
import { renderFacts } from './butler/facts.js';
import { wire } from './wiring.js';

/**
 * 管家的命令行入口。
 *
 *   npm run ask -- "昨天有什么动静"
 *   npm run ask -- "上周谁改得最多" --hours 168
 *   npm run brief                 # 日报（没内容就不发）
 *   npm run brief -- --week       # 周报
 *   npm run brief -- --week --send   # 周报，并且送出去（文件 / 桌面通知 / 飞书）
 *
 * **它与人对话，所以 stdout 是给人看的** —— 与 MCP 出口那条「stdout 只走协议」
 * 正好相反。两者不冲突：MCP 是一个协议端点，这里是终端。
 */

const root = process.env.COLLAB_ROOT ?? process.cwd();
const dbRaw = process.env.COLLAB_DB ?? 'var/platform.db';
const dbPath = dbRaw === ':memory:' ? ':memory:' : resolve(root, dbRaw);

const { values, positionals } = parseArgs({
  options: {
    hours: { type: 'string' },
    day: { type: 'boolean' },
    week: { type: 'boolean' },
    month: { type: 'boolean' },
    send: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    facts: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

const command = positionals[0];
const w = wire({ root, dbPath, outDir: resolve(root, 'var/comments') });

/** Markdown → 纯文本。桌面通知和飞书 text 都不渲染 Markdown。 */
function stripMarkdown(md: string): string {
  return md
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function printFactsIfAsked(facts: unknown): void {
  if (!values.facts) return;
  process.stderr.write('\n──────── 这次用到的材料 ────────\n');
  process.stderr.write(renderFacts(facts as Parameters<typeof renderFacts>[0]) + '\n');
}

/** 没配模型时说清楚：不是「没问题」，是「我还没法开口」 */
function explainNoModel(): void {
  process.stderr.write(
    '\n提示：没有配置模型（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL）。\n' +
      '     记录都在，但我没法把它们组织成一句话 —— 直接念日志不叫回答。\n' +
      '     配好之后重跑即可；加 --facts 可以先看原始材料。\n',
  );
}

async function main(): Promise<number> {
  if (command === 'ask') {
    const question = positionals.slice(1).join(' ').trim();
    if (!question) {
      process.stderr.write('用法：npm run ask -- "你想问的话"\n');
      return 2;
    }

    const hours = values.hours ? Number(values.hours) : undefined;
    if (values.hours && (!Number.isFinite(hours) || (hours as number) <= 0)) {
      process.stderr.write(`--hours 不是一个正数：${values.hours}\n`);
      return 2;
    }

    const res = await ask(question, {
      store: w.store,
      llm: w.llm,
      llmConfigured: w.llmConfigured,
      hours,
    });

    if (values.json) {
      process.stdout.write(JSON.stringify({ ok: res.ok, answer: res.answer, error: res.error }, null, 2) + '\n');
    } else if (res.ok) {
      process.stdout.write(`\n${res.answer}\n\n`);
    } else {
      // 失败时说失败，不给半句像回答的话
      process.stdout.write(`\n${res.error}\n\n`);
      if (!w.llmConfigured) explainNoModel();
    }

    printFactsIfAsked(res.facts);
    return res.ok ? 0 : 1;
  }

  if (command === 'brief') {
    const period: Period = values.month ? 'month' : values.week ? 'week' : 'day';
    const res = await brief({
      store: w.store,
      llm: w.llm,
      llmConfigured: w.llmConfigured,
      period,
    });

    if (values.json) {
      process.stdout.write(
        JSON.stringify({ ok: res.ok, text: res.text, error: res.error, suppressed: res.suppressed ?? false }, null, 2) + '\n',
      );
    } else if (res.suppressed) {
      // 「没什么要说的」也要说出来 —— 否则它与「忘了跑」分不开
      process.stdout.write('\n今天没什么要说的（日报的纪律是没内容就不打扰）。\n\n');
    } else if (res.ok && res.text) {
      process.stdout.write(`\n${res.text}\n\n`);
    } else {
      process.stdout.write(`\n${res.error}\n\n`);
      if (!w.llmConfigured) explainNoModel();
    }

    printFactsIfAsked(res.facts);

    if (values.send && res.ok && res.text) {
      const name = period === 'day' ? '日报' : period === 'week' ? '周报' : '月报';
      const title = `协作平台 · ${name} ${new Date().toISOString().slice(0, 10)}`;
      const { results, delivered } = await deliver(
        { title, text: res.text, plain: stripMarkdown(res.text) },
        defaultChannels({ root }),
      );

      for (const r of results) {
        process.stderr.write(`  ${r.ok ? '✓' : '✗'} ${r.channel}${r.to ? ` → ${r.to}` : ''}${r.error ? `：${r.error}` : ''}\n`);
      }

      // 文件那一路失败才算没送出去 —— 桌面通知弹不出来不代表消息丢了
      if (!delivered) {
        process.stderr.write('\n⚠️ 一个通道都没送成功。这次的内容只在上面那段输出里。\n');
        return 1;
      }
    }

    return res.ok || res.suppressed ? 0 : 1;
  }

  process.stderr.write(
    '用法：\n' +
      '  butler-cli ask "问题" [--hours N] [--json] [--facts]\n' +
      '  butler-cli brief [--day|--week|--month] [--send] [--json] [--facts]\n',
  );
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`出错了：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
