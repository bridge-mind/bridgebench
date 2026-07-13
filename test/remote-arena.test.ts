import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteRun, fetchExecutionPack } from '../src/remote-arena.js';
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

/** A balanced public-only speed pack: 12 tasks, two per cluster. */
function speedPack() {
  const tasks = CATEGORY_CLUSTERS.speed.flatMap((cluster) => [
    speedPublicTask(cluster, 1),
    speedPublicTask(cluster, 2),
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
    expect(tasks).toHaveLength(12);
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
      matches: 12,
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
