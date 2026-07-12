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
});
