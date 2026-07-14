import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import {
  MODEL_REGISTRY,
  SOL_FABLE_PILOT_COMPETITOR_IDS,
  listModels,
} from '../src/models.js';
import type {
  ArenaEvent,
  ArenaRunConfig,
  ChatRequest,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
} from '../src/types.js';
import { makeCompletion, makeTask, withTempStore } from './helpers.js';

function runConfig(overrides: Partial<ArenaRunConfig> = {}): ArenaRunConfig {
  return {
    category: 'reasoning',
    seed: 'cancellation-test',
    matches: 1,
    maxCostUsd: 5,
    resume: false,
    competitorIds: SOL_FABLE_PILOT_COMPETITOR_IDS,
    ...overrides,
  };
}

function expectCancellationLifecycle(events: ArenaEvent[]): void {
  expect(events.slice(-2).map((event) => event.type)).toEqual([
    'run.cancellation-requested',
    'run.cancelled',
  ]);
}

function healthyCompletion(request: ChatRequest): ModelCompletion {
  if (request.model.role === 'competitor') {
    return makeCompletion(`Grounded response from ${request.model.id}`);
  }
  return makeCompletion(
    JSON.stringify({
      winner: 'MODEL_A',
      confidence: 0.9,
      rationale: 'Model A is the stronger fixture response.',
      criteria: {
        correctness: 'Correct.',
        grounding: 'Grounded.',
        constraintHandling: 'Constrained.',
        completeness: 'Complete.',
      },
      violations: [],
    }),
  );
}

class CountingGateway implements OpenRouterGateway {
  validationCalls = 0;
  completionCalls = 0;
  validatedModelIds: string[] = [];

  async validateModel(model: ModelRegistryEntry): Promise<void> {
    this.validationCalls += 1;
    this.validatedModelIds.push(model.id);
  }

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    this.completionCalls += 1;
    return healthyCompletion(request);
  }
}

describe('explicit competitor roster validation', () => {
  it.each([
    {
      name: 'a one-model roster',
      competitorIds: ['openai/gpt-5.6-sol'],
      expected: /at least two/,
    },
    {
      name: 'duplicate entries',
      competitorIds: ['openai/gpt-5.6-sol', 'openai/gpt-5.6-sol'],
      expected: /must be unique/,
    },
    {
      name: 'a judge in the competitor roster',
      competitorIds: ['openai/gpt-5.6-sol', 'google/gemini-3.1-pro-preview'],
      expected: /role=judge/,
    },
    {
      name: 'an unknown model',
      competitorIds: ['openai/gpt-5.6-sol', 'fixture/unknown'],
      expected: /Unknown competitor model/,
    },
  ])('rejects $name before provider calls', async ({ competitorIds, expected }) => {
    await withTempStore(async (store) => {
      const gateway = new CountingGateway();
      await expect(
        new ArenaRunner(gateway, store).run(runConfig({ competitorIds }), [makeTask()]),
      ).rejects.toThrow(expected);
      expect(gateway.validationCalls).toBe(0);
      expect(gateway.completionCalls).toBe(0);
      expect(store.readAll()).toEqual([]);
    });
  });

  it('rejects a disabled competitor before provider calls', async () => {
    const disabled = MODEL_REGISTRY['openai/gpt-5.6-terra']!;
    disabled.enabled = false;
    try {
      await withTempStore(async (store) => {
        const gateway = new CountingGateway();
        await expect(
          new ArenaRunner(gateway, store).run(
            runConfig({
              competitorIds: ['openai/gpt-5.6-sol', 'openai/gpt-5.6-terra'],
            }),
            [makeTask()],
          ),
        ).rejects.toThrow(/disabled/);
        expect(gateway.validationCalls).toBe(0);
        expect(gateway.completionCalls).toBe(0);
      });
    } finally {
      disabled.enabled = true;
    }
  });
});

describe('arena cancellation', () => {
  it('honors a pre-aborted signal without provider calls', async () => {
    await withTempStore(async (store) => {
      const gateway = new CountingGateway();
      const cancellation = new AbortController();
      const events: ArenaEvent[] = [];
      cancellation.abort();

      const result = await new ArenaRunner(gateway, store, (event) => events.push(event)).run(
        runConfig(),
        [makeTask()],
        { signal: cancellation.signal },
      );

      expect(result).toMatchObject({ completed: 0, cancelled: true });
      expect(gateway.validationCalls).toBe(0);
      expect(gateway.completionCalls).toBe(0);
      expect(store.readAll()).toEqual([]);
      expectCancellationLifecycle(events);
    });
  });

  it('stops before the first match and emits a terminal cancellation event', async () => {
    await withTempStore(async (store) => {
      const gateway = new CountingGateway();
      const cancellation = new AbortController();
      const events: ArenaEvent[] = [];
      const runner = new ArenaRunner(gateway, store, (event) => {
        events.push(event);
        if (event.type === 'run.started') cancellation.abort();
      });

      const result = await runner.run(runConfig(), [makeTask()], {
        signal: cancellation.signal,
      });

      expect(result).toMatchObject({ completed: 0, cancelled: true, stoppedForBudget: false });
      expect(gateway.completionCalls).toBe(0);
      expect(gateway.validationCalls).toBe(5);
      // Registry role no longer discriminates run participants — a dual-role
      // competitor (Grok 4.5) sits on the judge panel. Pin the full validated
      // set instead: the two scheduled competitors plus the judge panel.
      expect([...gateway.validatedModelIds].sort()).toEqual(
        [
          ...SOL_FABLE_PILOT_COMPETITOR_IDS,
          ...listModels('judge').map((judge) => judge.id),
        ].sort(),
      );
      expect(store.readAll()).toEqual([]);
      expectCancellationLifecycle(events);
      expect(events.some((event) => event.type === 'run.completed')).toBe(false);
    });
  });

  it('keeps a completed match and stops before scheduling the next one', async () => {
    await withTempStore(async (store) => {
      const cancellation = new AbortController();
      const events: ArenaEvent[] = [];
      const runner = new ArenaRunner(new CountingGateway(), store, (event) => {
        events.push(event);
        if (event.type === 'match.completed') cancellation.abort();
      });

      const result = await runner.run(runConfig({ matches: 2 }), [makeTask()], {
        signal: cancellation.signal,
      });

      expect(result).toMatchObject({ completed: 1, cancelled: true });
      expect(store.readAll()).toHaveLength(1);
      const snapshot = JSON.parse(readFileSync(store.config.snapshotPath, 'utf8')) as {
        leaderboard: Array<{ modelId: string }>;
      };
      expect(new Set(snapshot.leaderboard.map((entry) => entry.modelId))).toEqual(
        new Set(SOL_FABLE_PILOT_COMPETITOR_IDS),
      );
      expectCancellationLifecycle(events);
    });
  });

  it('aborts in-flight competitor requests without journaling a partial match', async () => {
    await withTempStore(async (store) => {
      const cancellation = new AbortController();
      const events: ArenaEvent[] = [];
      let competitorCalls = 0;
      const gateway: OpenRouterGateway = {
        async validateModel() {},
        async complete(request) {
          if (request.model.role === 'judge') {
            throw new Error('Judges must not run after competitor cancellation');
          }
          competitorCalls += 1;
          return new Promise<ModelCompletion>((_resolve, reject) => {
            expect(request.signal).toBe(cancellation.signal);
            request.signal!.addEventListener(
              'abort',
              () => reject(new Error('fixture request aborted')),
              { once: true },
            );
            if (competitorCalls === 2) queueMicrotask(() => cancellation.abort());
          });
        },
      };

      const result = await new ArenaRunner(gateway, store, (event) => events.push(event)).run(
        runConfig(),
        [makeTask()],
        { signal: cancellation.signal },
      );

      expect(result.cancelled).toBe(true);
      expect(competitorCalls).toBe(2);
      expect(store.readAll()).toEqual([]);
      expectCancellationLifecycle(events);
    });
  });

  it('aborts in-flight judge requests without journaling a partial match', async () => {
    await withTempStore(async (store) => {
      const cancellation = new AbortController();
      const events: ArenaEvent[] = [];
      let judgeCalls = 0;
      const gateway: OpenRouterGateway = {
        async validateModel() {},
        async complete(request) {
          if (request.model.role === 'competitor') return healthyCompletion(request);
          judgeCalls += 1;
          return new Promise<ModelCompletion>((_resolve, reject) => {
            expect(request.signal).toBe(cancellation.signal);
            request.signal!.addEventListener(
              'abort',
              () => reject(new Error('fixture judge request aborted')),
              { once: true },
            );
            if (judgeCalls === 3) queueMicrotask(() => cancellation.abort());
          });
        },
      };

      const result = await new ArenaRunner(gateway, store, (event) => events.push(event)).run(
        runConfig(),
        [makeTask()],
        { signal: cancellation.signal },
      );

      expect(result.cancelled).toBe(true);
      expect(judgeCalls).toBe(3);
      expect(store.readAll()).toEqual([]);
      expectCancellationLifecycle(events);
    });
  });
});
