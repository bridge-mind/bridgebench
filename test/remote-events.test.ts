import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteArenaEventSink } from '../src/remote-events.js';
import type { ArenaEvent } from '../src/types.js';

const config = {
  baseUrl: 'http://127.0.0.1:8083',
  adminKey: 'test-admin-key',
  timeoutMs: 5_000,
};

function makeEvent(id: string, offsetMs: number): ArenaEvent {
  return {
    id,
    type: 'competitor.delta',
    timestamp: new Date(Date.UTC(2026, 6, 11, 16, 0, offsetMs)).toISOString(),
    data: {
      matchId: 'match-fixture-000',
      modelId: 'openai/gpt-5.6-sol',
      side: 'A',
      text: id,
      done: false,
      success: true,
    },
  };
}

describe('RemoteArenaEventSink', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('buffers and flushes events to the admin append endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ imported: 1, skipped: 0, cursor: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const sink = new RemoteArenaEventSink(config, 'run-fixture');
    sink.sink(makeEvent('delta-1', 0));
    sink.sink(makeEvent('delta-2', 1));
    await sink.close();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8083/arena/runs/run-fixture/events');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as { events: ArenaEvent[] };
    expect(body.events).toHaveLength(2);
  });

  it('requeues a failed flush and delivers the events in order on retry', async () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    let failNext = true;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      if (failNext) {
        failNext = false;
        throw new Error('socket hang up');
      }
      const body = JSON.parse(String(init.body)) as { events: ArenaEvent[] };
      delivered.push(...body.events.map((event) => event.id));
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            imported: body.events.length,
            skipped: 0,
            cursor: 1,
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const failures: boolean[] = [];
    const sink = new RemoteArenaEventSink(config, 'run-fixture', (_m, fatal) =>
      failures.push(fatal),
    );
    sink.sink(makeEvent('delta-1', 0));
    sink.sink(makeEvent('delta-2', 1));

    // First flush fails, retry fires after backoff and succeeds.
    await vi.advanceTimersByTimeAsync(10_000);
    const closing = sink.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;

    expect(delivered).toEqual(['delta-1', 'delta-2']);
    expect(failures).toEqual([false]);
  });

  it('fires the cancel callback once even across repeated flagged flushes', async () => {
    vi.useFakeTimers();
    let flushCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      flushCount += 1;
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            imported: 1,
            skipped: 0,
            cursor: flushCount,
            cancelRequested: true,
          }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const cancelRequests = vi.fn();
    const sink = new RemoteArenaEventSink(config, 'run-fixture', () => {}, cancelRequests);
    sink.sink(makeEvent('delta-1', 0));
    await vi.advanceTimersByTimeAsync(1_000);
    sink.sink(makeEvent('delta-2', 1));
    const closing = sink.close();
    await vi.advanceTimersByTimeAsync(1_000);
    await closing;

    // Both flushes reported cancelRequested; the abort fired exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(cancelRequests).toHaveBeenCalledTimes(1);
  });

  it('tolerates append responses without the cancel flag', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ imported: 1, skipped: 0, cursor: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const cancelRequests = vi.fn();
    const sink = new RemoteArenaEventSink(config, 'run-fixture', () => {}, cancelRequests);
    sink.sink(makeEvent('delta-1', 0));
    await sink.close();
    expect(cancelRequests).not.toHaveBeenCalled();
  });

  it('close surrenders the mirror instead of throwing when the API stays down', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', fetchMock);

    const failures: boolean[] = [];
    const sink = new RemoteArenaEventSink(config, 'run-fixture', (_m, fatal) =>
      failures.push(fatal),
    );
    sink.sink(makeEvent('delta-1', 0));

    const closing = sink.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(closing).resolves.toBeUndefined();

    // The final attempt reports a fatal degradation, not a crash.
    expect(failures.at(-1)).toBe(true);
    // Once degraded, new events are dropped silently.
    sink.sink(makeEvent('delta-2', 1));
  });
});
