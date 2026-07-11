import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import type { ArenaEvent, ChatRequest, ModelCompletion } from '../src/types.js';
import { FixtureGateway, makeCompletion, makeMatch, makeTask, withTempStore } from './helpers.js';

function judgeCompletion(request: ChatRequest): ModelCompletion {
  const payload = JSON.parse(request.user) as {
    modelA: { response: string };
    modelB: { response: string };
  };
  const scoreA = Number(payload.modelA.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
  const scoreB = Number(payload.modelB.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
  return makeCompletion(
    JSON.stringify({
      winner: scoreA >= scoreB ? 'MODEL_A' : 'MODEL_B',
      confidence: 0.9,
      rationale: 'The higher fixture quality wins.',
      criteria: {
        correctness: 'Compared.',
        grounding: 'Compared.',
        constraintHandling: 'Compared.',
        completeness: 'Compared.',
      },
      violations: [],
    }),
    { costUsd: 0.001 },
  );
}

function healthyGateway(costUsd = 0.01): FixtureGateway {
  return new FixtureGateway((request) => {
    if (request.model.role === 'judge') return judgeCompletion(request);
    const quality = [...request.model.id].reduce(
      (sum, character) => sum + character.charCodeAt(0),
      0,
    );
    return makeCompletion(`QUALITY=${quality}`, { costUsd });
  });
}

describe('arena outcome contract', () => {
  it('records a single exhausted competitor as a forfeit without judging', async () => {
    await withTempStore(async (store) => {
      let competitors = 0;
      const gateway = new FixtureGateway((request) => {
        if (request.model.role === 'judge') {
          throw new Error('judges must not run for a forfeit');
        }
        competitors += 1;
        if (competitors === 1) throw new Error('fixture failure');
        return makeCompletion('surviving response');
      });
      await new ArenaRunner(gateway, store).run(
        {
          category: 'reasoning',
          seed: 'forfeit',
          matches: 1,
          maxCostUsd: 5,
          resume: false,
        },
        [makeTask()],
      );
      const [match] = store.readAll();
      expect(match).toMatchObject({
        outcome: 'forfeit',
        pointAwarded: true,
        panel: null,
      });
      expect(match!.winnerModelId).not.toBeNull();
      expect(gateway.requests.filter((request) => request.model.role === 'judge')).toHaveLength(0);
    });
  });

  it('records two exhausted competitors as a no-contest', async () => {
    await withTempStore(async (store) => {
      const gateway = new FixtureGateway(() => {
        throw new Error('fixture failure');
      });
      await new ArenaRunner(gateway, store).run(
        {
          category: 'reasoning',
          seed: 'no-contest',
          matches: 1,
          maxCostUsd: 5,
          resume: false,
          healthStop: false,
        },
        [makeTask()],
      );
      expect(store.readAll()[0]).toMatchObject({
        outcome: 'no-contest',
        winnerModelId: null,
        pointAwarded: false,
        panel: null,
      });
    });
  });

  it('stops before the next match at the configured budget boundary', async () => {
    await withTempStore(async (store) => {
      const result = await new ArenaRunner(healthyGateway(), store).run(
        {
          category: 'reasoning',
          seed: 'budget',
          matches: 3,
          maxCostUsd: 0.001,
          resume: false,
        },
        [makeTask()],
      );
      expect(result).toMatchObject({ completed: 1, stoppedForBudget: true });
      expect(store.readAll()).toHaveLength(1);
    });
  });

  it('rejects a repeated schedule unless resume is explicit', async () => {
    await withTempStore(async (store) => {
      const config = {
        category: 'reasoning' as const,
        seed: 'resume',
        matches: 1,
        maxCostUsd: 5,
        resume: false,
      };
      await new ArenaRunner(healthyGateway(), store).run(config, [makeTask()]);
      await expect(
        new ArenaRunner(healthyGateway(), store).run(config, [makeTask()]),
      ).rejects.toThrow(/already journaled/);
      const resumed = await new ArenaRunner(healthyGateway(), store).run(
        { ...config, resume: true },
        [makeTask()],
      );
      expect(resumed.completed).toBe(0);
    });
  });

  it('rejects a legacy methodology before model validation or paid work', async () => {
    await withTempStore(async (store) => {
      store.append(makeMatch({ methodologyVersion: 'reasoning-arena-v0.2.0' }));
      const gateway = healthyGateway();
      await expect(
        new ArenaRunner(gateway, store).run(
          {
            category: 'reasoning',
            seed: 'new-methodology',
            matches: 1,
            maxCostUsd: 5,
            resume: false,
          },
          [makeTask()],
        ),
      ).rejects.toThrow(/Cannot append arena-v0.3.0 matches/);
      expect(gateway.requests).toHaveLength(0);
    });
  });

  it('emits lifecycle events in contract order', async () => {
    await withTempStore(async (store) => {
      const events: ArenaEvent[] = [];
      await new ArenaRunner(healthyGateway(), store, (event) => events.push(event)).run(
        {
          category: 'reasoning',
          seed: 'event-order',
          matches: 1,
          maxCostUsd: 5,
          resume: false,
        },
        [makeTask()],
      );
      const positions = new Map(events.map((event, index) => [event.type, index]));
      expect(positions.get('run.started')).toBeLessThan(positions.get('match.started')!);
      expect(positions.get('match.started')).toBeLessThan(positions.get('competitors.completed')!);
      expect(positions.get('competitors.completed')).toBeLessThan(
        positions.get('judging.started')!,
      );
      expect(positions.get('judging.started')).toBeLessThan(positions.get('judge.completed')!);
      expect(positions.get('judge.completed')).toBeLessThan(positions.get('match.completed')!);
      expect(positions.get('match.completed')).toBeLessThan(positions.get('run.completed')!);
    });
  });
});
