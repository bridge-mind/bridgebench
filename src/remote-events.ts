import { z } from 'zod';

import { chunk, delay, postJson, type ApiConfig } from './api-client.js';
import type { ArenaEvent } from './types.js';

const AppendEventsResponseSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  // Older APIs omit this; absence means "not cancelled".
  cancelRequested: z.boolean().optional(),
});

const MAX_BATCH_SIZE = 50;
const FLUSH_DELAY_MS = 150;
const INTER_EVENT_DELAY_MS = Number(process.env.REMOTE_EVENT_DELAY_MS ?? '') || 0;
const FLUSH_RETRY_BASE_MS = 2_000;
const MAX_CONSECUTIVE_FLUSH_FAILURES = 8;
const CLOSE_FLUSH_ATTEMPTS = 3;

/** Called when a flush fails; `fatal` means the sink gave up on the mirror. */
export type FlushErrorHandler = (message: string, fatal: boolean) => void;

export class RemoteArenaEventSink {
  private readonly buffer: ArenaEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private closed = false;
  private consecutiveFailures = 0;
  private degraded = false;
  private cancelNotified = false;

  constructor(
    private readonly config: ApiConfig,
    private readonly runKey: string,
    private readonly onFlushError: FlushErrorHandler = () => {},
    /**
     * Fired once when an append response reports `cancelRequested` — an
     * admin cancelled the run on the API. The event stream doubles as the
     * cancel back-channel because it is the only request a runner repeats
     * for the whole life of a run.
     */
    private readonly onCancelRequested: () => void = () => {},
  ) {}

  readonly sink = (event: ArenaEvent): void => {
    if (this.closed || this.degraded) return;
    this.buffer.push(event);
    this.scheduleFlush();
  };

  private scheduleFlush(delayMs = FLUSH_DELAY_MS): void {
    // Once close() starts it owns the final drain; don't race it.
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushChain = this.flushChain.then(() => this.flushGuarded());
    }, delayMs);
  }

  /**
   * The background flush must never reject: an unhandled rejection here
   * kills the whole run over a hiccup in the event MIRROR, while the match
   * journal — the system of record — lives locally and publishes separately.
   * Failed batches are requeued in order and retried with backoff; after too
   * many consecutive failures the sink degrades to a no-op so the run can
   * still finish and publish its matches.
   */
  private async flushGuarded(): Promise<void> {
    try {
      await this.flush();
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FLUSH_FAILURES) {
        this.degraded = true;
        this.buffer.length = 0;
        this.onFlushError(message, true);
        return;
      }
      this.onFlushError(message, false);
      this.scheduleFlush(FLUSH_RETRY_BASE_MS * this.consecutiveFailures);
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer.splice(0, this.buffer.length);
    const batchSize = INTER_EVENT_DELAY_MS > 0 ? 1 : MAX_BATCH_SIZE;
    const batches = chunk(pending, batchSize);
    for (let index = 0; index < batches.length; index += 1) {
      try {
        const response = await postJson(
          this.config,
          `/arena/runs/${encodeURIComponent(this.runKey)}/events`,
          { events: batches[index] },
          AppendEventsResponseSchema,
        );
        if (response.cancelRequested && !this.cancelNotified) {
          this.cancelNotified = true;
          this.onCancelRequested();
        }
      } catch (error) {
        // Requeue every unsent event, in order, ahead of anything that
        // arrived while this flush was in flight.
        this.buffer.unshift(...batches.slice(index).flat());
        throw error;
      }
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
    if (this.degraded) return;
    // Final drain with bounded retries. A completed run must not fail over
    // the mirror: surrender the remaining events rather than throw.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.flush();
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= CLOSE_FLUSH_ATTEMPTS) {
          this.degraded = true;
          this.onFlushError(message, true);
          return;
        }
        this.onFlushError(message, false);
        await delay(FLUSH_RETRY_BASE_MS * attempt);
      }
    }
  }
}
