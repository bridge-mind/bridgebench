import { z } from 'zod';

import { chunk, delay, postJson, type ApiConfig } from './api-client.js';
import type { ArenaEvent } from './types.js';

const AppendEventsResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
});

const MAX_BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 150;
const INTER_EVENT_DELAY_MS = Number(process.env.REMOTE_EVENT_DELAY_MS ?? '') || 0;

export class RemoteArenaEventSink {
  private readonly buffer: ArenaEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly config: ApiConfig,
    private readonly runKey: string,
  ) {}

  readonly sink = (event: ArenaEvent): void => {
    if (this.closed) return;
    this.buffer.push(event);
    this.scheduleFlush();
  };

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushChain = this.flushChain.then(() => this.flush());
    }, FLUSH_DELAY_MS);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    const batchSize = INTER_EVENT_DELAY_MS > 0 ? 1 : MAX_BATCH_SIZE;
    for (const batch of chunk(pending, batchSize)) {
      await postJson(
        this.config,
        `/arena/runs/${encodeURIComponent(this.runKey)}/events`,
        { events: batch },
        AppendEventsResponseSchema,
      );
      if (INTER_EVENT_DELAY_MS > 0) await delay(INTER_EVENT_DELAY_MS);
      else await delay(100);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushChain;
    await this.flush();
  }
}
