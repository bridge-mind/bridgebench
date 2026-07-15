import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRemoteRun,
  fetchExecutionPack,
  remoteResultsRoot,
  runRemoteArena,
  shouldPublishRemoteMatches,
} from '../src/remote-arena.js';
import { SOL_FABLE_PILOT_COMPETITOR_IDS } from '../src/models.js';
import { CATEGORY_CLUSTERS, METHODOLOGY_VERSION, type ArenaRunConfig } from '../src/types.js';

const apiConfig = {
  baseUrl: 'http://127.0.0.1:8083',
  adminKey: 'test-admin-key',
  timeoutMs: 1_000,
};

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** A public-only speed task: no hidden half, null private hash. */
function speedPublicTask(cluster: string, index: number) {
  const publicHalf = {
    id: `speed-${cluster}-${index}`,
    version: '1.0.0',
    category: 'speed',
    cluster,
    difficulty: 'hard',
    title: `Speed ${cluster} ${index}`,
    summary: 'A latency race task.',
    prompt: 'Complete the task as fast as possible.',
    artifacts: [{ id: 'a1', type: 'note', label: 'Note', content: 'x' }],
    tags: [],
  };
  return {
    public: publicHalf,
    private: null,
    publicHash: hash(publicHalf),
    privateHash: null,
  };
}

/** A balanced public-only speed pack: 18 tasks, three per cluster. */
function speedPack() {
  const tasks = CATEGORY_CLUSTERS.speed.flatMap((cluster) => [
    speedPublicTask(cluster, 1),
    speedPublicTask(cluster, 2),
    speedPublicTask(cluster, 3),
  ]);
  return {
    category: 'speed',
    methodologyVersion: METHODOLOGY_VERSION,
    competitors: [],
    judges: [],
    tasks,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('remote speed run', () => {
  it('accepts a rubric-less speed execution pack', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(speedPack())),
    );
    const { tasks } = await fetchExecutionPack(apiConfig, 'speed');
    expect(tasks).toHaveLength(18);
    expect(tasks.every((task) => task.private === null && task.privateHash === null)).toBe(true);
  });

  it('creates a speed run whose manifest binds no judges', async () => {
    const pack = speedPack();
    let postedBody: {
      category: string;
      runKey: string;
      manifest: {
        judges: unknown[];
        tasks: Array<{ privateHash: string | null }>;
      };
    } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          postedBody = JSON.parse(init.body as string);
          return jsonResponse({
            created: true,
            run: { runKey: postedBody!.runKey, status: 'queued' },
          });
        }
        return jsonResponse(pack);
      }),
    );

    const config: ArenaRunConfig = {
      category: 'speed',
      seed: 'speed-seed',
      matches: 18,
      maxCostUsd: 5,
      resume: false,
      competitorIds: SOL_FABLE_PILOT_COMPETITOR_IDS,
    };
    const { tasks } = await fetchExecutionPack(apiConfig, 'speed');
    const result = await createRemoteRun(apiConfig, config, tasks);

    expect(result.created).toBe(true);
    expect(postedBody).not.toBeNull();
    expect(postedBody!.category).toBe('speed');
    // The whole point: a speed manifest carries no judges and no private hashes.
    expect(postedBody!.manifest.judges).toEqual([]);
    expect(postedBody!.manifest.tasks.every((task) => task.privateHash === null)).toBe(true);
  });
});

describe('remote run failure reporting', () => {
  it('reports run.failed to the API when the run dies mid-flight', async () => {
    const resultsDir = mkdtempSync(path.join(os.tmpdir(), 'bridgebench-test-'));
    const previousResultsDir = process.env.BRIDGEBENCH_RESULTS_DIR;
    process.env.BRIDGEBENCH_RESULTS_DIR = resultsDir;
    const appendedEvents: Array<{ type: string; data: { error?: string } }> = [];
    // The pack serves speed tasks to a reasoning run, so the engine accepts
    // the pack and creates the run, then dies inside ArenaRunner.run on the
    // category mismatch — a failure after the run row exists, exactly the
    // case that must be reported so the arena does not stay live forever.
    const pack = speedPack();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const target = String(url);
        if (init?.method === 'POST' && target.endsWith('/events')) {
          const body = JSON.parse(init.body as string) as {
            events: Array<{ type: string; data: { error?: string } }>;
          };
          appendedEvents.push(...body.events);
          return jsonResponse({
            imported: body.events.length,
            skipped: 0,
            cursor: appendedEvents.length,
          });
        }
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body as string) as { runKey: string };
          return jsonResponse({
            created: true,
            run: { runKey: body.runKey, status: 'queued' },
          });
        }
        return jsonResponse(pack);
      }),
    );

    const config: ArenaRunConfig = {
      category: 'reasoning',
      seed: 'failure-seed',
      matches: 2,
      maxCostUsd: 5,
      resume: false,
      competitorIds: SOL_FABLE_PILOT_COMPETITOR_IDS,
    };
    try {
      await expect(
        runRemoteArena(apiConfig, { config, mock: true, publishMatches: false }),
      ).rejects.toThrow(/another arena/);
      const failed = appendedEvents.find((event) => event.type === 'run.failed');
      expect(failed).toBeDefined();
      expect(failed?.data.error).toContain('another arena');
    } finally {
      if (previousResultsDir === undefined) delete process.env.BRIDGEBENCH_RESULTS_DIR;
      else process.env.BRIDGEBENCH_RESULTS_DIR = previousResultsDir;
      rmSync(resultsDir, { recursive: true, force: true });
    }
  });
});

describe('mock-run isolation', () => {
  it('never publishes matches from a mock run, even when publishing is requested', () => {
    expect(shouldPublishRemoteMatches(true)).toBe(false);
    expect(shouldPublishRemoteMatches(true, true)).toBe(false);
    expect(shouldPublishRemoteMatches(false, true)).toBe(true);
    expect(shouldPublishRemoteMatches(false, false)).toBe(false);
    expect(shouldPublishRemoteMatches(false)).toBe(true);
  });

  it('keeps mock journals in a subtree a live run never reads', () => {
    const live = remoteResultsRoot('reasoning', false);
    const mock = remoteResultsRoot('reasoning', true);
    expect(live.split(path.sep)).toContain('remote');
    expect(mock.split(path.sep)).toContain('remote-mock');
    expect(mock).not.toBe(live);
  });
});
