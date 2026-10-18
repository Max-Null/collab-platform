import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * 出口 —— 她说的话往哪儿送。
 *
 * 三条约定：
 *
 * ① **没配的通道保持安静**。飞书没配 webhook 就不发，不报错、不降级成一句
 *    「（飞书未配置）」塞进正文 —— 那种句子出现在给人看的内容里，就是在告诉读者
 *    「这条消息本来该发到别处」。
 *
 * ② **文件永远写**。库和文件是这个平台唯一能自证的记录：所有通道都失败了，
 *    至少还留得下一份 —— 而「发出去过」这件事本身不能只存在于某个第三方服务里。
 *
 * ③ **失败要说出来，不能静默**。三个通道全挂时返回失败，
 *    而不是「没有消息 = 没有要说的」。这两件事在结果里必须分开。
 */

export interface OutgoingMessage {
  /** 标题（文件名、桌面通知的标题行） */
  title: string;
  /** 正文，Markdown */
  text: string;
  /** 纯文本版 —— 桌面通知与纯文本通道用，因为有的地方渲染不了 Markdown */
  plain: string;
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
  /** 实际送到哪儿了（文件路径 / 主机名） */
  to?: string;
}

export interface Channel {
  readonly name: string;
  /** 这个通道配好了吗。没配好的一律跳过，不报错 */
  ready(): boolean;
  send(msg: OutgoingMessage): Promise<ChannelResult>;
}

/* ── 文件：永远写 ──────────────────────────────────────────── */

export class FileChannel implements Channel {
  readonly name = 'file';
  constructor(private readonly dir: string) {}

  ready(): boolean {
    return true;
  }

  async send(msg: OutgoingMessage): Promise<ChannelResult> {
    try {
      mkdirSync(this.dir, { recursive: true });
      // 文件名带日期与周期：同一份日报重跑会覆盖，而不是留下两份
      // （两份长得一样的东西，日后没人分得清哪份是最后那份）
      const stamp = new Date().toISOString().slice(0, 10);
      const safe = msg.title.replace(/[\\/:*?"<>|\s]+/g, '-');
      const path = resolve(this.dir, `${stamp}-${safe}.md`);
      writeFileSync(path, `# ${msg.title}\n\n${msg.text}\n`, 'utf8');
      return { channel: this.name, ok: true, to: path };
    } catch (err) {
      return { channel: this.name, ok: false, error: (err as Error).message };
    }
  }
}

/* ── 桌面通知：尽力而为 ────────────────────────────────────────
   ⚠️ 它**不参与成功判定**。通知弹不出来（没登录、被系统策略挡掉、
   PowerShell 被禁用）不代表这条消息没送出去 —— 文件已经写过了。
   把它算进失败，会让「没有桌面通知」和「什么都没送出去」混成一件事。 */

export class DesktopChannel implements Channel {
  readonly name = 'desktop';
  constructor(private readonly enabled = process.platform === 'win32') {}

  ready(): boolean {
    return this.enabled;
  }

  async send(msg: OutgoingMessage): Promise<ChannelResult> {
    // Windows toast 走 PowerShell 的 WinRT 绑定。不用 BurntToast 这类模块：
    // 那需要在目标机器上装东西，而这个平台一向是「拷过去就能跑」。
    const title = msg.title.replace(/'/g, "''");
    const body = msg.plain.split('\n').slice(0, 6).join('\n').replace(/'/g, "''").slice(0, 400);

    const script = `
$ErrorActionPreference='Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$texts = $tpl.GetElementsByTagName('text')
$texts.Item(0).AppendChild($tpl.CreateTextNode('${title}')) | Out-Null
$texts.Item(1).AppendChild($tpl.CreateTextNode('${body}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('协作平台').Show($toast)
`.trim();

    return await new Promise((done) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        // 不捕获输出：这条命令只是去弹一个通知，它说了什么没人读。
        // 捕获 stdout 在沙箱化环境里还可能直接 EPERM —— 而那不是这里要测的东西。
        { stdio: 'ignore', windowsHide: true, detached: false },
      );
      const timer = setTimeout(() => {
        child.kill();
        done({ channel: this.name, ok: false, error: '弹通知超时（可能被系统策略挡掉了）' });
      }, 8000);
      child.on('error', (err) => {
        clearTimeout(timer);
        done({ channel: this.name, ok: false, error: err.message });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        done(
          code === 0
            ? { channel: this.name, ok: true }
            : { channel: this.name, ok: false, error: `powershell 退出码 ${code}` },
        );
      });
    });
  }
}

/* ── 飞书自定义机器人 ────────────────────────────────────────── */

export class FeishuChannel implements Channel {
  readonly name = 'feishu';
  constructor(
    private readonly webhook = process.env.BUTLER_FEISHU_WEBHOOK,
    private readonly secret = process.env.BUTLER_FEISHU_SECRET,
  ) {}

  ready(): boolean {
    return Boolean(this.webhook);
  }

  async send(msg: OutgoingMessage): Promise<ChannelResult> {
    if (!this.webhook) return { channel: this.name, ok: false, error: '没有配置 BUTLER_FEISHU_WEBHOOK' };

    const body: Record<string, unknown> = {
      msg_type: 'text',
      content: { text: `${msg.title}\n\n${msg.plain}` },
    };

    // 机器人开了「签名校验」才需要。默认不开，所以这是可选的 ——
    // 配了 secret 却不签名，飞书那边会静默拒收（返回 code 非 0），
    // 而那看起来跟「网络不通」很像。
    if (this.secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      const sign = createHmac('sha256', `${ts}\n${this.secret}`).update('').digest('base64');
      body.timestamp = ts;
      body.sign = sign;
    }

    try {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return { channel: this.name, ok: false, error: `HTTP ${res.status}：${text.slice(0, 200)}` };

      // 飞书即使 HTTP 200 也可能在 body 里报错（签名不对、关键词不匹配…）
      try {
        const j = JSON.parse(text) as { code?: number; msg?: string };
        if (typeof j.code === 'number' && j.code !== 0) {
          return { channel: this.name, ok: false, error: `飞书返回 code ${j.code}：${j.msg ?? text.slice(0, 200)}` };
        }
      } catch {
        // body 不是 JSON 但 HTTP 200 —— 多半是代理页面，如实当成功但不猜
      }
      return { channel: this.name, ok: true, to: new URL(this.webhook).host };
    } catch (err) {
      return { channel: this.name, ok: false, error: (err as Error).message };
    }
  }
}

/**
 * 把一条消息送到所有通道，并如实汇报每个通道的结果。
 *
 * ⚠️ **判定「成功了没有」只看必达通道**（文件）。桌面通知与飞书是尽力而为：
 * 它们失败时要被看见，但不该让一条已经落盘的消息变成「没发出去」。
 */
export function defaultChannels(opts: { root: string; outDir?: string }): Channel[] {
  return [
    new FileChannel(resolve(opts.root, opts.outDir ?? 'var/briefs')),
    new DesktopChannel(),
    new FeishuChannel(),
  ];
}

export async function deliver(
  msg: OutgoingMessage,
  channels: Channel[],
): Promise<{ results: ChannelResult[]; delivered: boolean }> {
  const active = channels.filter((c) => c.ready());
  const results: ChannelResult[] = [];

  for (const c of active) {
    results.push(await c.send(msg));
  }

  // 文件那一路是必达的：它 ok 了就算送达，其余失败只是「没送到那儿」
  const delivered = results.some((r) => r.ok && r.channel === 'file');
  return { results, delivered };
}
