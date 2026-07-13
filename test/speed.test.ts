import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import { SOL_FABLE_PILOT_COMPETITOR_IDS } from '../src/models.js';
import { decideSpeedMatch, isLiveResponse, speedMetricFor, speedWinner } from '../src/speed.js';
import { MatchResultSchema, type MatchResult } from '../src/types.js';
import { verifyJournal } from '../src/verification.js';
import {
  FixtureGateway,
  makeCompletion,
  makeFailure,
  makeSuccess,
  makeTask,
  withTempStore,
} from './helpers.js';

const SOL = 'openai/gpt-5.6-sol';
const FABLE = 'anthropic/claude-fable-5';

function speedConfig(seed: string) {
  return {
    category: 'speed' as const,
    seed,
    matches: 1,
    maxCostUsd: 5,
    resume: false,
    competitorIds: SOL_FABLE_PILOT_COMPETITOR_IDS,
  };
}

function speedTask() {
  return makeTask({ category: 'speed', cluster: 'short-completion' });
}

function fixturePath(): string {
  return path.resolve('test', 'fixtures', 'journals', 'speed-valid.jsonl');
}

function readFixtureLine(): string {
  return readFileSync(fixturePath(), 'utf8').trim();
}

describe('speed decision rule', () => {
  it('awards the win to the lower total wall-clock time', () => {
    const fast = makeSuccess('model/fast', 'done', { ttftMs: 100, totalMs: 500, outputTokens: 40 });
    const slow = makeSuccess('model/slow', 'done', { ttftMs: 200, totalMs: 900, outputTokens: 40 });
    const decision = decideSpeedMatch(fast, slow, 'model/fast', 'model/slow');
    expect(decision.outcome).toBe('speed-decided');
    expect(decision.winnerModelId).toBe('model/fast');
    expect(decision.speedMetrics?.a.totalMs).toBe(500);
    expect(decision.speedMetrics?.b.totalMs).toBe(900);
    // Same inputs, sides swapped — the faster model still wins.
    expect(decideSpeedMatch(slow, fast, 'model/slow', 'model/fast').winnerModelId).toBe(
      'model/fast',
    );
  });

  it('breaks an exact tie deterministically toward modelA', () => {
    const a = makeSuccess('model/a', 'done', { ttftMs: 100, totalMs: 500, outputTokens: 40 });
    const b = makeSuccess('model/b', 'done', { ttftMs: 100, totalMs: 500, outputTokens: 40 });
    expect(decideSpeedMatch(a, b, 'model/a', 'model/b').winnerModelId).toBe('model/a');
    expect(speedWinner({ a: speedMetricFor(a), b: speedMetricFor(b) }, 'model/a', 'model/b')).toBe(
      'model/a',
    );
  });

  it('forfeits to the live competitor when the other errors', () => {
    const live = makeSuccess('model/a', 'done', { ttftMs: 80, totalMs: 400, outputTokens: 30 });
    const dead = makeFailure('model/b', 'competitor exhausted');
    expect(decideSpeedMatch(live, dead, 'model/a', 'model/b')).toMatchObject({
      outcome: 'forfeit',
      winnerModelId: 'model/a',
      speedMetrics: null,
    });
    expect(decideSpeedMatch(dead, live, 'model/b', 'model/a')).toMatchObject({
      outcome: 'forfeit',
      winnerModelId: 'model/a',
      speedMetrics: null,
    });
  });

  it('treats a successful-but-empty completion as not live', () => {
    const empty = makeSuccess('model/a', '   ', { ttftMs: 10, totalMs: 100, outputTokens: 0 });
    const live = makeSuccess('model/b', 'real answer', {
      ttftMs: 50,
      totalMs: 300,
      outputTokens: 20,
    });
    expect(isLiveResponse(empty)).toBe(false);
    expect(isLiveResponse(live)).toBe(true);
    expect(decideSpeedMatch(empty, live, 'model/a', 'model/b')).toMatchObject({
      outcome: 'forfeit',
      winnerModelId: 'model/b',
    });
  });

  it('is a no-contest when both competitors fail', () => {
    expect(
      decideSpeedMatch(makeFailure('model/a'), makeFailure('model/b'), 'model/a', 'model/b'),
    ).toMatchObject({ outcome: 'no-contest', winnerModelId: null, speedMetrics: null });
  });

  it('computes output tokens per second over the post-first-token window', () => {
    const metric = speedMetricFor(
      makeSuccess('x', 'ok', { ttftMs: 200, totalMs: 1200, outputTokens: 100 }),
    );
    // (1200 - 200) / 1000 = 1.0 second of generation -> 100 tps.
    expect(metric.tps).toBeCloseTo(100, 9);
  });
});

describe('speed arena runner', () => {
  it('decides by latency, skips the judge panel, and records both metrics', async () => {
    await withTempStore(async (store) => {
      const gateway = new FixtureGateway((request) => {
        if (request.model.role === 'judge') throw new Error('speed matches must not invoke judges');
        const totalMs = request.model.id === SOL ? 800 : 1600;
        return makeCompletion(`answer from ${request.model.id}`, {
          ttftMs: Math.round(totalMs / 4),
          totalMs,
          latencyMs: totalMs,
          outputTokens: 50,
          costUsd: 0.01,
        });
      });
      await new ArenaRunner(gateway, store).run(speedConfig('faster-wins'), [speedTask()]);
      const [match] = store.readAll();
      expect(match!.outcome).toBe('speed-decided');
      expect(match!.winnerModelId).toBe(SOL);
      expect(match!.panel).toBeNull();
      expect(match!.pointAwarded).toBe(true);
      expect(match!.speedMetrics).not.toBeNull();
      expect(gateway.requests.filter((request) => request.model.role === 'judge')).toHaveLength(0);
    }, 'speed');
  });

  it('forfeits to the surviving competitor without judging', async () => {
    await withTempStore(async (store) => {
      const gateway = new FixtureGateway((request) => {
        if (request.model.role === 'judge') throw new Error('no judges in speed');
        if (request.model.id === FABLE) throw new Error('competitor exhausted');
        return makeCompletion('sol survives', {
          ttftMs: 120,
          totalMs: 700,
          latencyMs: 700,
          outputTokens: 40,
          costUsd: 0.01,
        });
      });
      await new ArenaRunner(gateway, store).run(
        { ...speedConfig('speed-forfeit'), healthStop: false },
        [speedTask()],
      );
      const [match] = store.readAll();
      expect(match!.outcome).toBe('forfeit');
      expect(match!.winnerModelId).toBe(SOL);
      expect(match!.speedMetrics ?? null).toBeNull();
      expect(match!.panel).toBeNull();
    }, 'speed');
  });

  it('is a no-contest when both competitors fail', async () => {
    await withTempStore(async (store) => {
      const gateway = new FixtureGateway(() => {
        throw new Error('fixture failure');
      });
      await new ArenaRunner(gateway, store).run(
        { ...speedConfig('speed-no-contest'), healthStop: false },
        [speedTask()],
      );
      const [match] = store.readAll();
      expect(match!.outcome).toBe('no-contest');
      expect(match!.winnerModelId).toBeNull();
      expect(match!.pointAwarded).toBe(false);
      expect(match!.speedMetrics ?? null).toBeNull();
    }, 'speed');
  });
});

describe('speed journal schema and verification', () => {
  it('accepts a speed line and rejects malformed speed metrics', () => {
    const line = JSON.parse(readFixtureLine()) as Record<string, unknown>;
    expect(MatchResultSchema.safeParse(line).success).toBe(true);

    const missingTps = JSON.parse(readFixtureLine()) as {
      speedMetrics: { a: Record<string, unknown> };
    };
    delete missingTps.speedMetrics.a.tps;
    expect(MatchResultSchema.safeParse(missingTps).success).toBe(false);
  });

  it('replays the recorded speed journal and re-derives points and Elo', () => {
    const matches = readFixtureLine()
      .split('\n')
      .filter(Boolean)
      .map((raw) => MatchResultSchema.parse(JSON.parse(raw)));
    const verified = verifyJournal(matches, 'speed');
    expect(verified.matches).toHaveLength(1);
    expect(verified.points).toEqual({ 'fixture/model-a': 1 });
    expect(verified.ratings).toEqual({ 'fixture/model-a': 1016, 'fixture/model-b': 984 });
  });

  it('rejects a speed line whose winner is not the lower total time', () => {
    const tampered = MatchResultSchema.parse(JSON.parse(readFixtureLine()));
    const forged: MatchResult = { ...tampered, winnerModelId: 'fixture/model-b' };
    expect(() => verifyJournal([forged], 'speed')).toThrow(/winner expected fixture\/model-a/);
  });

  it('rejects a speed line whose speedMetrics were edited away from the responses', () => {
    const tampered = MatchResultSchema.parse(JSON.parse(readFixtureLine()));
    const forged: MatchResult = {
      ...tampered,
      speedMetrics: {
        a: { ...tampered.speedMetrics!.a, totalMs: 10 },
        b: tampered.speedMetrics!.b,
      },
    };
    expect(() => verifyJournal([forged], 'speed')).toThrow(/speedMetrics\.a\.totalMs/);
  });
});
