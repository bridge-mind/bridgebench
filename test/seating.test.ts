import { describe, expect, it } from 'vitest';

import { MODEL_REGISTRY, listModels } from '../src/models.js';
import {
  CALIBRATED_JUDGE_IDS,
  JUDGE_PANEL_SIZE,
  SeatingError,
  eligibleJudgeIds,
  rankEligibleJudges,
  seatPanel,
  seatReserves,
  vendorOf,
} from '../src/seating.js';

// The calibrated (grandfathered arena-v0.4.0) five plus the uncalibrated
// judge-only additions from non-competitor vendors.
const CALIBRATED_POOL = [
  'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.5',
  'z-ai/glm-5.2',
  'openai/gpt-5.6-sol',
  'moonshotai/kimi-k2.7-code',
];
const UNCALIBRATED_POOL = ['mistralai/mistral-medium-3-5', 'nvidia/nemotron-3-ultra-550b-a55b'];
const POOL = [...CALIBRATED_POOL, ...UNCALIBRATED_POOL];

// The API's cleared run competitors (bridgebench-api ARENA_RUN_COMPETITOR_IDS).
const CLEARED_COMPETITOR_IDS = [
  'openai/gpt-5.6-sol',
  'anthropic/claude-fable-5',
  'x-ai/grok-4.5',
  'z-ai/glm-5.2',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6',
  'openai/gpt-5.5',
  'qwen/qwen3.7-max',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.7-code',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/kimi-k3',
  'meta/muse-spark-1.1',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'minimax/minimax-m3',
  'minimax/minimax-m2.7',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-haiku-4.5',
  'google/gemini-3.5-flash',
  'google/gemma-4-31b-it',
  'xiaomi/mimo-v2.5-pro',
  'openai/gpt-oss-120b',
  'thinkingmachines/inkling',
  'google/gemini-3.1-pro-preview',
  'mistralai/mistral-medium-3-5',
  'nvidia/nemotron-3-ultra-550b-a55b',
];

function clearedPairs(): [string, string][] {
  const pairs: [string, string][] = [];
  for (let a = 0; a < CLEARED_COMPETITOR_IDS.length; a += 1) {
    for (let b = a + 1; b < CLEARED_COMPETITOR_IDS.length; b += 1) {
      pairs.push([CLEARED_COMPETITOR_IDS[a]!, CLEARED_COMPETITOR_IDS[b]!]);
    }
  }
  return pairs;
}

describe('vendorOf', () => {
  it('is the OpenRouter id prefix', () => {
    expect(vendorOf('x-ai/grok-4.5')).toBe('x-ai');
    expect(vendorOf('moonshotai/kimi-k2.7-code')).toBe('moonshotai');
    expect(vendorOf('no-slash')).toBe('no-slash');
  });
});

describe('seatPanel', () => {
  it('matches the registry judge pool used by real runs', () => {
    expect(
      listModels('judge')
        .map((judge) => judge.id)
        .sort(),
    ).toEqual([...POOL].sort());
  });

  it('is deterministic and independent of pool input order', () => {
    const seated = seatPanel(POOL, ['anthropic/claude-fable-5', 'minimax/minimax-m3'], 's', 'm-1');
    expect(seated).toHaveLength(JUDGE_PANEL_SIZE);
    expect(
      seatPanel(
        [...POOL].reverse(),
        ['anthropic/claude-fable-5', 'minimax/minimax-m3'],
        's',
        'm-1',
      ),
    ).toEqual(seated);
    expect(seatPanel(POOL, ['anthropic/claude-fable-5', 'minimax/minimax-m3'], 's', 'm-1')).toEqual(
      seated,
    );
  });

  it('reseats when the seed or match changes', () => {
    const competitors = ['anthropic/claude-fable-5', 'minimax/minimax-m3'];
    const panels = new Set(
      ['m-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6'].map((matchId) =>
        seatPanel(POOL, competitors, 'seed', matchId).join(','),
      ),
    );
    // Five eligible calibrated judges contend for three primary seats — six
    // matches under one seed should not all land on one composition.
    expect(panels.size).toBeGreaterThan(1);
  });

  it('never seats a judge sharing a vendor with either competitor, across every cleared pairing', () => {
    for (const [modelA, modelB] of clearedPairs()) {
      const eligible = eligibleJudgeIds(POOL, [modelA, modelB]);
      expect(eligible.length, `${modelA} vs ${modelB}`).toBeGreaterThanOrEqual(JUDGE_PANEL_SIZE);
      const seated = seatPanel(POOL, [modelA, modelB], 'seed', `match-${modelA}-${modelB}`);
      expect(seated).toHaveLength(JUDGE_PANEL_SIZE);
      expect(new Set(seated).size).toBe(JUDGE_PANEL_SIZE);
      const conflicted = new Set([vendorOf(modelA), vendorOf(modelB)]);
      for (const judgeId of seated) {
        expect(conflicted.has(vendorOf(judgeId)), `${judgeId} on ${modelA} vs ${modelB}`).toBe(
          false,
        );
      }
    }
  });

  it('the grok–glm worst case seats the calibrated trio with the new judges in reserve', () => {
    const competitors = ['x-ai/grok-4.5', 'z-ai/glm-5.2'];
    const seated = seatPanel(POOL, competitors, 'any-seed', 'any-match');
    expect([...seated].sort()).toEqual(
      ['google/gemini-3.1-pro-preview', 'openai/gpt-5.6-sol', 'moonshotai/kimi-k2.7-code'].sort(),
    );
    // Before the pool expansion this pairing had zero adjudication reserves;
    // the vendor-neutral additions now cover it.
    expect([...seatReserves(POOL, competitors, 'any-seed', 'any-match')].sort()).toEqual(
      [...UNCALIBRATED_POOL].sort(),
    );
  });

  it('fails closed when the pool cannot cover the pairing', () => {
    const smallPool = ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'];
    expect(() =>
      seatPanel(smallPool, ['x-ai/grok-4.5', 'z-ai/glm-5.2'], 'seed', 'match-1'),
    ).toThrow(SeatingError);
    expect(() =>
      seatPanel(smallPool, ['x-ai/grok-4.5', 'z-ai/glm-5.2'], 'seed', 'match-1'),
    ).toThrow(/cannot seat 3 judges/);
  });

  it('rotates every calibrated eligible judge into a primary seat across many matches', () => {
    const competitors = ['anthropic/claude-fable-5', 'anthropic/claude-opus-4.8'];
    const eligible = eligibleJudgeIds(POOL, competitors);
    expect(eligible).toHaveLength(POOL.length);
    const seatedEver = new Set<string>();
    for (let index = 0; index < 40; index += 1) {
      for (const judgeId of seatPanel(POOL, competitors, 'dist-seed', `match-${index}`)) {
        seatedEver.add(judgeId);
      }
    }
    // Primary seats belong to the calibrated class while at least three of
    // its members are eligible; the uncalibrated additions never appear.
    expect([...seatedEver].sort()).toEqual([...CALIBRATED_POOL].sort());
  });
});

describe('calibration-aware ranking', () => {
  it('mirrors the registry: exactly the grandfathered five are calibrated', () => {
    expect([...CALIBRATED_JUDGE_IDS].sort()).toEqual([...CALIBRATED_POOL].sort());
    for (const judgeId of CALIBRATED_JUDGE_IDS) {
      expect(MODEL_REGISTRY[judgeId], judgeId).toBeDefined();
    }
  });

  // Since the 2026-07-18 coding-index wave every pool member's vendor also
  // competes, so no pairing is conflict-free for the whole pool anymore. The
  // invariant that matters instead: the pool spans seven distinct vendors and
  // a match excludes at most two, so every cleared pairing keeps at least
  // five eligible judges — a full primary panel plus both adjudication
  // reserves.
  it('every cleared pairing keeps a full panel plus both reserves eligible', () => {
    const poolVendors = new Set(POOL.map(vendorOf));
    expect(poolVendors.size).toBe(POOL.length);
    for (const [modelA, modelB] of clearedPairs()) {
      const eligible = eligibleJudgeIds(POOL, [modelA, modelB]);
      expect(eligible.length, `${modelA} vs ${modelB}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('ranks every calibrated judge ahead of every uncalibrated one', () => {
    const competitors = ['anthropic/claude-fable-5', 'minimax/minimax-m3'];
    for (let index = 0; index < 25; index += 1) {
      const ranked = rankEligibleJudges(POOL, competitors, 'cal-seed', `match-${index}`);
      const calibratedRanks = ranked
        .map((judgeId, rank) => ({ judgeId, rank }))
        .filter(({ judgeId }) => CALIBRATED_JUDGE_IDS.has(judgeId))
        .map(({ rank }) => rank);
      const uncalibratedRanks = ranked
        .map((judgeId, rank) => ({ judgeId, rank }))
        .filter(({ judgeId }) => !CALIBRATED_JUDGE_IDS.has(judgeId))
        .map(({ rank }) => rank);
      expect(Math.max(...calibratedRanks)).toBeLessThan(Math.min(...uncalibratedRanks));
    }
  });

  it('the expanded pool re-derives every historical primary trio byte-for-byte', () => {
    // The arena-v0.4.0 pool was exactly the calibrated five, so ranking the
    // seven-judge pool calibrated-first must seat the same primary trio the
    // old five-judge pool did for any (competitors, seed, matchId).
    for (const competitors of [
      ['anthropic/claude-fable-5', 'minimax/minimax-m3'],
      ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5'],
      ['x-ai/grok-4.5', 'z-ai/glm-5.2'],
      ['moonshotai/kimi-k2.7-code', 'z-ai/glm-5.2'],
    ]) {
      for (let index = 0; index < 10; index += 1) {
        expect(seatPanel(POOL, competitors, 'replay-seed', `match-${index}`)).toEqual(
          seatPanel(CALIBRATED_POOL, competitors, 'replay-seed', `match-${index}`),
        );
      }
    }
  });

  it('an explicit calibration set overrides the default constant', () => {
    const competitors = ['anthropic/claude-fable-5', 'minimax/minimax-m3'];
    const allCalibrated = rankEligibleJudges(
      POOL,
      competitors,
      'override-seed',
      'match-1',
      new Set(POOL),
    );
    // With every judge calibrated the ordering degenerates to the pure hash
    // ordering — the exact pre-calibration behavior.
    const pureHash = rankEligibleJudges(POOL, competitors, 'override-seed', 'match-1', new Set());
    expect([...allCalibrated].sort()).toEqual([...pureHash].sort());
    expect(allCalibrated).toEqual(pureHash);
  });
});
