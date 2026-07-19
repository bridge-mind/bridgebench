import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import { SOL_FABLE_PILOT_COMPETITOR_IDS } from '../src/models.js';
import {
  decideSpeedMatch,
  isLiveResponse,
  medianTrialResponse,
  speedMetricFor,
  speedWinner,
  SPEED_TRIALS,
} from '../src/speed.js';
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

  it('voids an exact millisecond tie instead of awarding seat A', () => {
    const a = makeSuccess('model/a', 'done', { ttftMs: 100, totalMs: 500, outputTokens: 40 });
    const b = makeSuccess('model/b', 'done', { ttftMs: 100, totalMs: 500, outputTokens: 40 });
    const decision = decideSpeedMatch(a, b, 'model/a', 'model/b');
    expect(decision.outcome).toBe('no-contest');
    expect(decision.winnerModelId).toBeNull();
    // The tie is still evidenced by journaled metrics.
    expect(decision.speedMetrics?.a.totalMs).toBe(500);
    expect(decision.speedMetrics?.b.totalMs).toBe(500);
    expect(
      speedWinner({ a: speedMetricFor(a), b: speedMetricFor(b) }, 'model/a', 'model/b'),
    ).toBeNull();
  });

  it('journals the median-total trial', () => {
    const trial = (totalMs: number) =>
      makeSuccess('model/a', `answer ${totalMs}`, { ttftMs: 50, totalMs, outputTokens: 40 });
    expect(medianTrialResponse([trial(900), trial(300), trial(600)]).totalMs).toBe(600);
    // Even count: the lower-middle trial wins deterministically.
    expect(medianTrialResponse([trial(900), trial(300)]).totalMs).toBe(300);
    expect(() => medianTrialResponse([])).toThrow(/at least one trial/);
  });

  it('voids the match when one competitor errors — an outage is not a slowness signal', () => {
    const live = makeSuccess('model/a', 'done', { ttftMs: 80, totalMs: 400, outputTokens: 30 });
    const dead = makeFailure('model/b', 'competitor exhausted');
    expect(decideSpeedMatch(live, dead, 'model/a', 'model/b')).toMatchObject({
      outcome: 'no-contest',
      winnerModelId: null,
      speedMetrics: null,
    });
    expect(decideSpeedMatch(dead, live, 'model/b', 'model/a')).toMatchObject({
      outcome: 'no-contest',
      winnerModelId: null,
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
      outcome: 'no-contest',
      winnerModelId: null,
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
      // Median-of-N paired trials: each competitor answers SPEED_TRIALS times.
      expect(gateway.requests).toHaveLength(SPEED_TRIALS * 2);
    }, 'speed');
  });

  it('journals each side\u2019s median trial and sums the cost of all trials', async () => {
    await withTempStore(async (store) => {
      // Per-side trial timings: SOL's median (500) beats FABLE's (700) even
      // though FABLE produced the single fastest trial (200) — an outlier
      // burst no longer decides the match.
      const timings: Record<string, number[]> = {
        [SOL]: [900, 500, 400],
        [FABLE]: [200, 800, 700],
      };
      const seen: Record<string, number> = {};
      const gateway = new FixtureGateway((request) => {
        if (request.model.role === 'judge') throw new Error('no judges in speed');
        const trialIndex = seen[request.model.id] ?? 0;
        seen[request.model.id] = trialIndex + 1;
        const totalMs = timings[request.model.id]![trialIndex]!;
        return makeCompletion(`trial ${trialIndex} from ${request.model.id}`, {
          ttftMs: 100,
          totalMs,
          latencyMs: totalMs,
          outputTokens: 40,
          costUsd: 0.01,
        });
      });
      await new ArenaRunner(gateway, store).run(speedConfig('median-decides'), [speedTask()]);
      const [match] = store.readAll();
      expect(match!.outcome).toBe('speed-decided');
      expect(match!.winnerModelId).toBe(SOL);
      const solSeat = match!.competitors.modelA === SOL ? 'a' : 'b';
      const fableSeat = solSeat === 'a' ? 'b' : 'a';
      expect(match!.speedMetrics![solSeat].totalMs).toBe(500);
      expect(match!.speedMetrics![fableSeat].totalMs).toBe(700);
      // Journaled cost covers every trial, and stays the verifiable sum of
      // the two journaled responses' own costUsd.
      expect(match!.matchCostUsd).toBeCloseTo(0.01 * SPEED_TRIALS * 2, 9);
      const { responseA, responseB } = match!.competitors;
      expect(responseA.success && responseA.costUsd).toBeCloseTo(0.01 * SPEED_TRIALS, 9);
      expect(responseB.success && responseB.costUsd).toBeCloseTo(0.01 * SPEED_TRIALS, 9);
    }, 'speed');
  });

  it('voids the match for the surviving competitor without judging or Elo movement', async () => {
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
      expect(match!.outcome).toBe('no-contest');
      expect(match!.winnerModelId).toBeNull();
      expect(match!.pointAwarded).toBe(false);
      expect(match!.eloAfter).toEqual(match!.eloBefore);
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
