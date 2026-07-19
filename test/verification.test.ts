import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { applyEloWin, ELO_INITIAL } from '../src/elo.js';
import { counterbalancedSwap } from '../src/judges.js';
import { listModels, SOL_FABLE_PILOT_COMPETITOR_IDS } from '../src/models.js';
import { createRunManifest, runIdFromManifest, runManifestHash } from '../src/run-manifest.js';
import { eligibleJudgeIds, seatPanel, seatReserves } from '../src/seating.js';
import { ArenaStore } from '../src/store.js';
import { METHODOLOGY_VERSION, type MatchResult } from '../src/types.js';
import { verifyJournal } from '../src/verification.js';
import { makeFailure, makeMatch, makeSuccess, makeTask, makeVote } from './helpers.js';

function fixtureStore(name: string): ArenaStore {
  const journalPath = path.resolve('test', 'fixtures', 'journals', name);
  return new ArenaStore({
    category: 'reasoning',
    journalPath,
    snapshotPath: `${journalPath}.snapshot`,
    markdownPath: `${journalPath}.md`,
    readOnly: true,
  });
}

describe('journal verification', () => {
  it('replays a valid journal from initial Elo', () => {
    const store = fixtureStore('valid.jsonl');
    const verified = verifyJournal(store.readAll(), 'reasoning', {
      manifestForRun: (runId) => store.readRunManifest(runId),
      requireManifests: true,
    });
    const expected = JSON.parse(
      readFileSync(path.resolve('test', 'fixtures', 'journals', 'expected-ladder.json'), 'utf8'),
    ) as { ratings: Record<string, number>; points: Record<string, number> };
    expect(verified.ratings).toEqual(expected.ratings);
    expect(verified.points).toEqual(expected.points);
    expect(verified.matches).toHaveLength(1);
    expect(verified.warnings).toEqual([]);
  });

  it('rejects a tampered rating at the exact line', () => {
    const store = fixtureStore('tampered-rating.jsonl');
    expect(() => verifyJournal(store.readAll(), 'reasoning')).toThrow(
      /Journal line 1: eloAfter\.fixture\/model-a expected 1016, found 1017/,
    );
  });

  it('derives a stable run identity from all canonical inputs', async () => {
    const tasks = [makeTask()];
    const config = {
      category: 'reasoning' as const,
      seed: 'manifest-test',
      matches: 4,
    };
    const first = createRunManifest(config, tasks);
    const second = createRunManifest(config, [...tasks].reverse());
    expect(first.competitors.map((model) => model.id)).toEqual(
      listModels('competitor')
        .map((model) => model.id)
        .sort(),
    );
    expect(runManifestHash(first)).toBe(runManifestHash(second));
    expect(runIdFromManifest(first)).toBe(runIdFromManifest(second));
    expect(runIdFromManifest(createRunManifest({ ...config, seed: 'changed' }, tasks))).not.toBe(
      runIdFromManifest(first),
    );
  });

  it('binds only the selected Sol/Fable competitors into the run manifest', () => {
    const manifest = createRunManifest(
      {
        category: 'reasoning',
        seed: 'pilot-manifest',
        matches: 12,
        competitorIds: SOL_FABLE_PILOT_COMPETITOR_IDS,
      },
      [makeTask()],
    );

    expect(manifest.competitors.map((model) => model.id)).toEqual(
      [...SOL_FABLE_PILOT_COMPETITOR_IDS].sort(),
    );
    expect(manifest.competitors).toHaveLength(2);
    expect(manifest.judges).toHaveLength(7);
    const reversed = createRunManifest(
      {
        category: 'reasoning',
        seed: 'pilot-manifest',
        matches: 12,
        competitorIds: [...SOL_FABLE_PILOT_COMPETITOR_IDS].reverse(),
      },
      [makeTask()],
    );
    expect(runIdFromManifest(reversed)).toBe(runIdFromManifest(manifest));
  });
});

/**
 * A journal line whose panel is judged by exactly `judges`, unanimous for
 * modelA, internally consistent (Elo chain, costs, identities) so only the
 * rotation rules under test decide whether it verifies.
 */
function rotationMatch(options: {
  modelA: string;
  modelB: string;
  judges: string[];
  methodologyVersion?: string;
  /** Per-judge [seatAIdentity, seatBIdentity]; defaults to the unswapped order. */
  seatIdentities?: (judgeId: string) => [string, string];
  overrides?: Partial<MatchResult>;
}): MatchResult {
  const { modelA, modelB, judges } = options;
  const responseA = makeSuccess(modelA);
  const responseB = makeSuccess(modelB);
  const votes = judges.map((judgeId) => {
    const [seatA, seatB] = options.seatIdentities?.(judgeId) ?? [modelA, modelB];
    return makeVote(judgeId, modelA, seatA, seatB);
  });
  const update = applyEloWin(ELO_INITIAL, ELO_INITIAL, 'a');
  return makeMatch({
    methodologyVersion: options.methodologyVersion ?? METHODOLOGY_VERSION,
    competitors: { modelA, modelB, responseA, responseB },
    winnerModelId: modelA,
    panel: {
      winnerModelId: modelA,
      validVotes: votes.length,
      votesByModel: { [modelA]: votes.length, [modelB]: 0 },
      agreement: votes.length === 3 ? 'unanimous' : 'insufficient',
      votes,
    },
    eloBefore: { [modelA]: ELO_INITIAL, [modelB]: ELO_INITIAL },
    eloAfter: { [modelA]: update.ratingA, [modelB]: update.ratingB },
    matchCostUsd:
      responseA.costUsd +
      responseB.costUsd +
      votes.reduce((sum, vote) => sum + (vote.completion?.costUsd ?? 0), 0),
    ...options.overrides,
  });
}

describe('seated-panel verification (arena-v0.4.0)', () => {
  const CONFLICT_FREE_TRIO = ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'];

  it('accepts a conflict-free seated panel without a manifest', () => {
    const match = rotationMatch({
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'anthropic/claude-fable-5',
      judges: CONFLICT_FREE_TRIO,
    });
    const verified = verifyJournal([match], 'reasoning');
    expect(verified.matches).toHaveLength(1);
  });

  it('rejects a judge sharing a vendor with a competitor, even without a manifest', () => {
    const match = rotationMatch({
      modelA: 'x-ai/grok-4.5',
      modelB: 'anthropic/claude-fable-5',
      judges: ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'],
    });
    expect(() => verifyJournal([match], 'reasoning')).toThrow(/shares a vendor/);
  });

  it('rejects duplicate judges and short panels', () => {
    const duplicated = rotationMatch({
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'anthropic/claude-fable-5',
      judges: ['google/gemini-3.1-pro-preview', 'google/gemini-3.1-pro-preview', 'z-ai/glm-5.2'],
    });
    expect(() => verifyJournal([duplicated], 'reasoning')).toThrow(/duplicate judges/);

    const short = rotationMatch({
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'anthropic/claude-fable-5',
      judges: ['google/gemini-3.1-pro-preview', 'z-ai/glm-5.2'],
    });
    expect(() => verifyJournal([short], 'reasoning')).toThrow(/between 3 and 5 votes/);

    const shortLegacy = rotationMatch({
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'anthropic/claude-fable-5',
      judges: ['google/gemini-3.1-pro-preview', 'z-ai/glm-5.2'],
      methodologyVersion: 'arena-v0.4.0',
    });
    expect(() => verifyJournal([shortLegacy], 'reasoning')).toThrow(/exactly 3 votes/);
  });

  it('still accepts the fixed-panel era: a v0.3.0 dual-role self-vote verifies', () => {
    const match = rotationMatch({
      modelA: 'x-ai/grok-4.5',
      modelB: 'anthropic/claude-fable-5',
      judges: ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'],
      methodologyVersion: 'arena-v0.3.0',
    });
    const verified = verifyJournal([match], 'reasoning');
    expect(verified.methodologyVersion).toBe('arena-v0.3.0');
    expect(verified.matches).toHaveLength(1);
  });

  it('requires the exact seated trio when the manifest is supplied', () => {
    const task = makeTask();
    const seed = 'rotation-seed';
    const competitors = ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5'];
    const manifest = createRunManifest(
      { category: 'reasoning', seed, matches: 4, competitorIds: competitors },
      [task],
    );
    const poolIds = manifest.judges.map((model) => model.id);
    const matchId = 'match-rotation-0';
    const seated = seatPanel(poolIds, competitors, seed, matchId);
    const seatOrder = [...seated, ...seatReserves(poolIds, competitors, seed, matchId)];
    const counterbalanced = (judgeId: string): [string, string] =>
      counterbalancedSwap(matchId, seatOrder.indexOf(judgeId))
        ? [competitors[1]!, competitors[0]!]
        : [competitors[0]!, competitors[1]!];

    const bindRun = (
      judges: string[],
      seatIdentities: (judgeId: string) => [string, string] = counterbalanced,
    ): MatchResult =>
      rotationMatch({
        modelA: competitors[0]!,
        modelB: competitors[1]!,
        judges,
        seatIdentities,
        overrides: {
          runId: runIdFromManifest(manifest),
          runManifestHash: runManifestHash(manifest),
          matchId,
          seed,
          task: {
            id: task.public.id,
            version: task.public.version,
            category: task.public.category,
            cluster: task.public.cluster,
            publicHash: task.publicHash,
            privateHash: task.privateHash,
          },
        },
      });

    const options = { manifestForRun: () => manifest, requireManifests: true };
    expect(verifyJournal([bindRun(seated)], 'reasoning', options).matches).toHaveLength(1);

    // A pool judge that is eligible but NOT seated for this match must fail.
    const unseated = eligibleJudgeIds(poolIds, competitors).find((id) => !seated.includes(id));
    expect(unseated).toBeDefined();
    const tampered = bindRun([unseated!, ...seated.slice(1)]);
    expect(() => verifyJournal([tampered], 'reasoning', options)).toThrow(
      /not on the seated panel/,
    );

    // A rewritten per-judge seat permutation must fail counterbalance replay.
    const flipped = bindRun(seated, (judgeId) => {
      const [seatA, seatB] = counterbalanced(judgeId);
      return judgeId === seated[0] ? [seatB, seatA] : [seatA, seatB];
    });
    expect(() => verifyJournal([flipped], 'reasoning', options)).toThrow(
      /counterbalanced assignment/,
    );
  });
});

describe('vote resolution and forfeit gating', () => {
  const TRIO = ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'];
  const MODEL_A = 'openai/gpt-5.6-sol';
  const MODEL_B = 'anthropic/claude-fable-5';

  it('rejects a winnerModelId that does not resolve from the verdict label', () => {
    const match = rotationMatch({ modelA: MODEL_A, modelB: MODEL_B, judges: TRIO });
    const vote = match.panel!.votes[0]!;
    // The judge's label said MODEL_A (seat A = modelA); rewrite the resolved
    // winner without touching the label or the recorded permutation.
    vote.winnerModelId = MODEL_B;
    match.panel!.votesByModel = { [MODEL_A]: 2, [MODEL_B]: 1 };
    match.panel!.agreement = 'split';
    expect(() => verifyJournal([match], 'reasoning')).toThrow(
      /does not resolve from its MODEL_A verdict/,
    );
  });

  it('rejects seat identities that are not a permutation of the competitors', () => {
    const match = rotationMatch({
      modelA: MODEL_A,
      modelB: MODEL_B,
      judges: TRIO,
      seatIdentities: (judgeId) =>
        judgeId === TRIO[0] ? [MODEL_A, 'intruder/model'] : [MODEL_A, MODEL_B],
    });
    expect(() => verifyJournal([match], 'reasoning')).toThrow(
      /must be a permutation of the competitors/,
    );
  });

  it('rejects forfeit outcomes in the current methodology and warns on legacy ones', () => {
    const failure = makeFailure(MODEL_B, 'competitor exhausted');
    const forfeit = (methodologyVersion: string): MatchResult =>
      makeMatch({
        methodologyVersion,
        competitors: {
          modelA: MODEL_A,
          modelB: MODEL_B,
          responseA: makeSuccess(MODEL_A),
          responseB: failure,
        },
        outcome: 'forfeit',
        winnerModelId: MODEL_A,
        panel: null,
        eloBefore: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
        eloAfter: {
          [MODEL_A]: applyEloWin(ELO_INITIAL, ELO_INITIAL, 'a').ratingA,
          [MODEL_B]: applyEloWin(ELO_INITIAL, ELO_INITIAL, 'a').ratingB,
        },
        matchCostUsd: makeSuccess(MODEL_A).costUsd,
      });

    expect(() => verifyJournal([forfeit(METHODOLOGY_VERSION)], 'reasoning')).toThrow(
      /forfeit outcomes were retired/,
    );

    const legacy = verifyJournal([forfeit('arena-v0.4.0')], 'reasoning');
    expect(legacy.matches).toHaveLength(1);
    expect(legacy.warnings.some((warning) => /legacy forfeit/.test(warning))).toBe(true);
  });
});

describe('exhibition matches (arena-v0.6.0)', () => {
  const TRIO = ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'];
  const MODEL_A = 'openai/gpt-5.6-sol';
  const MODEL_B = 'anthropic/claude-fable-5';

  function exhibitionMatch(overrides: Partial<MatchResult> = {}): MatchResult {
    return rotationMatch({
      modelA: MODEL_A,
      modelB: MODEL_B,
      judges: TRIO,
      overrides: {
        ranked: false,
        eloBefore: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
        eloAfter: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
        ...overrides,
      },
    });
  }

  it('verifies a frozen-Elo exhibition win and awards no ladder point', () => {
    const verified = verifyJournal([exhibitionMatch()], 'reasoning');
    expect(verified.matches).toHaveLength(1);
    expect(verified.ratings[MODEL_A]).toBe(ELO_INITIAL);
    expect(verified.ratings[MODEL_B]).toBe(ELO_INITIAL);
    expect(verified.points[MODEL_A]).toBeUndefined();
  });

  it('rejects an exhibition line whose Elo moved anyway', () => {
    const update = applyEloWin(ELO_INITIAL, ELO_INITIAL, 'a');
    const moved = exhibitionMatch({
      eloAfter: { [MODEL_A]: update.ratingA, [MODEL_B]: update.ratingB },
    });
    expect(() => verifyJournal([moved], 'reasoning')).toThrow(/eloAfter/);
  });

  it('rejects a ranked line whose Elo was frozen', () => {
    const frozen = rotationMatch({
      modelA: MODEL_A,
      modelB: MODEL_B,
      judges: TRIO,
      overrides: {
        eloAfter: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
      },
    });
    expect(() => verifyJournal([frozen], 'reasoning')).toThrow(/eloAfter/);
  });

  it('rejects a backdated exhibition flag on a pre-v0.6.0 line', () => {
    const backdated = exhibitionMatch({ methodologyVersion: 'arena-v0.5.0' });
    expect(() => verifyJournal([backdated], 'reasoning')).toThrow(
      /exhibition matches are not valid under arena-v0\.5\.0/,
    );
  });

  it('rejects a journal line whose ranked flag disagrees with its manifest', () => {
    const task = makeTask();
    const seed = 'exhibition-manifest';
    const competitors = [MODEL_A, MODEL_B];
    const manifest = createRunManifest(
      {
        category: 'reasoning',
        seed,
        matches: 4,
        competitorIds: competitors,
        ranked: true,
      },
      [task],
    );
    const poolIds = manifest.judges.map((model) => model.id);
    const matchId = 'match-exhibition-0';
    const seated = seatPanel(poolIds, competitors, seed, matchId);
    const seatOrder = [...seated, ...seatReserves(poolIds, competitors, seed, matchId)];
    const counterbalanced = (judgeId: string): [string, string] =>
      counterbalancedSwap(matchId, seatOrder.indexOf(judgeId))
        ? [MODEL_B, MODEL_A]
        : [MODEL_A, MODEL_B];
    const line = rotationMatch({
      modelA: MODEL_A,
      modelB: MODEL_B,
      judges: seated,
      seatIdentities: counterbalanced,
      overrides: {
        ranked: false,
        runId: runIdFromManifest(manifest),
        runManifestHash: runManifestHash(manifest),
        matchId,
        seed,
        eloBefore: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
        eloAfter: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
        task: {
          id: task.public.id,
          version: task.public.version,
          category: task.public.category,
          cluster: task.public.cluster,
          publicHash: task.publicHash,
          privateHash: task.privateHash,
        },
      },
    });
    expect(() =>
      verifyJournal([line], 'reasoning', {
        manifestForRun: () => manifest,
        requireManifests: true,
      }),
    ).toThrow(/ranked flag does not match the run manifest/);
  });
});
