import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeEvent } from '../types.js';
import type { EventSource } from './source.js';

/**
 * 本地样例事件源。
 *
 * 从目录里读 *.json，每个文件是一个 ChangeEvent。
 * 它存在的意义是：让整条管道能在**不碰任何真实系统**的前提下跑通与测试。
 */
export class MockEventSource implements EventSource {
  readonly name = 'mock';

  constructor(private readonly dir: string) {}

  async fetch(): Promise<ChangeEvent[]> {
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort();

    return files.map((file) => {
      const raw = readFileSync(join(this.dir, file), 'utf8');
      const parsed = JSON.parse(raw) as ChangeEvent;
      if (!parsed.id || !Array.isArray(parsed.changedFiles)) {
        throw new Error(`样例事件格式不对：${file}`);
      }
      return parsed;
    });
  }
}
