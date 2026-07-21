import { describe, expect, it } from 'vitest';

import {
  buildOverallLeaderboard,
  JUDGED_CATEGORIES,
  type JudgedBenchmarkCategory,
  type OverallArenaScore,
  type OverallModelScoreInput,
} from '../src/index.js';

function scores(
  value: number | ((category: JudgedBenchmarkCategory, index: number) => number),
): OverallArenaScore[] {
  return JUDGED_CATEGORIES.map((category, index) => ({
    category,
    score: typeof value === 'function' ? value(category, index) : value,
    rankedMatches: index + 1,
  }));
}

function model(
  modelId: string,
  arenaScores: readonly OverallArenaScore[],
  displayName = modelId,
): OverallModelScoreInput {
  return { modelId, displayName, arenaScores };
}

describe('coverage-aware overall leaderboard', () => {
  it('keeps the canonical judged-category contract immutable', () => {
    expect(Object.isFrozen(JUDGED_CATEGORIES)).toBe(true);
  });

  it('ranks a complete model by the unrounded equal-arena mean', () => {
    const arenaScores = scores((_category, index) => 970 + index * 10);
    const [entry] = buildOverallLeaderboard([model('complete', arenaScores)]);

    expect(entry).toMatchObject({
      rank: 1,
      status: 'ranked',
      coverage: { observed: 7, required: 7, missingCategories: [] },
    });
    expect(entry?.overallScore).toBeCloseTo(
      arenaScores.reduce((sum, arena) => sum + arena.score, 0) / 7,
    );
    expect(entry?.arenaScores.map((arena) => arena.rankedMatches)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps a sparse high-scoring model provisional below a complete model', () => {
    const sparse = scores((_category, index) => [1000.4, 1000.5, 1000.5][index] ?? 0).slice(0, 3);
    const formerImputedScore = (sparse.reduce((sum, arena) => sum + arena.score, 0) + 4 * 1000) / 7;
    expect(formerImputedScore).toBeCloseTo(1000.2);

    const leaderboard = buildOverallLeaderboard([
      model('opus', sparse, 'Claude Opus 4.8'),
      model('sol', scores(992.3), 'GPT-5.6 Sol'),
    ]);

    expect(leaderboard.map((entry) => entry.modelId)).toEqual(['sol', 'opus']);
    expect(leaderboard[0]).toMatchObject({
      rank: 1,
      status: 'ranked',
      coverage: { observed: 7, required: 7, missingCategories: [] },
    });
    expect(leaderboard[0]?.overallScore).toBeCloseTo(992.3);
    expect(leaderboard[1]).toMatchObject({
      rank: null,
      status: 'provisional',
      overallScore: null,
      coverage: {
        observed: 3,
        required: 7,
        missingCategories: ['bullshit', 'refactoring', 'debugging', 'generation'],
      },
    });
  });

  it('changes from provisional to ranked only when the seventh arena arrives', () => {
    const six = scores(1001).slice(0, 6);
    expect(buildOverallLeaderboard([model('candidate', six)])[0]).toMatchObject({
      rank: null,
      status: 'provisional',
      overallScore: null,
      coverage: { observed: 6, missingCategories: ['generation'] },
    });

    expect(buildOverallLeaderboard([model('candidate', scores(1001))])[0]).toMatchObject({
      rank: 1,
      status: 'ranked',
      overallScore: 1001,
      coverage: { observed: 7, missingCategories: [] },
    });
  });

  it('reports empty coverage canonically and handles an empty leaderboard', () => {
    expect(buildOverallLeaderboard([])).toEqual([]);
    expect(buildOverallLeaderboard([model('new-model', [])])[0]).toMatchObject({
      rank: null,
      status: 'provisional',
      overallScore: null,
      arenaScores: [],
      coverage: {
        observed: 0,
        required: 7,
        missingCategories: JUDGED_CATEGORIES,
      },
    });
  });

  it('rejects sparse model arrays instead of returning sparse output', () => {
    const sparse = new Array<OverallModelScoreInput>(1);
    expect(() => buildOverallLeaderboard(sparse)).toThrow(/model must be an object/);
  });

  it('canonicalizes arena rows and deterministically breaks complete-score ties', () => {
    const reversedScores = [...scores(1000)].reverse();
    const inputs = [
      model('model-z', reversedScores, 'Same name'),
      model('model-a', scores(1000), 'Same name'),
      model('model-b', scores(1000), 'Alpha'),
    ];

    const forward = buildOverallLeaderboard(inputs);
    const reversed = buildOverallLeaderboard([...inputs].reverse());
    expect(forward.map(({ modelId, rank }) => ({ modelId, rank }))).toEqual([
      { modelId: 'model-b', rank: 1 },
      { modelId: 'model-a', rank: 2 },
      { modelId: 'model-z', rank: 3 },
    ]);
    expect(reversed).toEqual(forward);
    expect(forward[2]?.arenaScores.map((arena) => arena.category)).toEqual(JUDGED_CATEGORIES);
  });

  it('sorts complete models by score and accepts zero and negative observed scores', () => {
    const leaderboard = buildOverallLeaderboard([
      model('zero', scores(0)),
      model('negative', scores(-1)),
      model('positive', scores(1)),
    ]);

    expect(
      leaderboard.map(({ modelId, overallScore, rank }) => ({ modelId, overallScore, rank })),
    ).toEqual([
      { modelId: 'positive', overallScore: 1, rank: 1 },
      { modelId: 'zero', overallScore: 0, rank: 2 },
      { modelId: 'negative', overallScore: -1, rank: 3 },
    ]);
  });

  it('averages finite extreme scores without intermediate overflow', () => {
    expect(
      buildOverallLeaderboard([model('maximum', scores(Number.MAX_VALUE))])[0]?.overallScore,
    ).toBe(Number.MAX_VALUE);
  });

  it('does not mutate deeply frozen caller input', () => {
    const reversedScores = Object.freeze(
      [...scores(1000)].reverse().map((arena) => Object.freeze(arena)),
    );
    const input = Object.freeze([
      Object.freeze({
        modelId: 'frozen',
        displayName: 'Frozen',
        arenaScores: reversedScores,
      }),
    ]);

    const leaderboard = buildOverallLeaderboard(input);
    expect(reversedScores.map((arena) => arena.category)).toEqual([...JUDGED_CATEGORIES].reverse());
    expect(leaderboard[0]?.arenaScores.map((arena) => arena.category)).toEqual(JUDGED_CATEGORIES);
  });

  it('orders provisional entries by identity, never by their partial score', () => {
    const leaderboard = buildOverallLeaderboard([
      model('z-low', [{ category: 'reasoning', score: -100, rankedMatches: 1 }], 'Zulu'),
      model('a-high', [{ category: 'reasoning', score: 10_000, rankedMatches: 1 }], 'Alpha'),
      model('complete', scores(900), 'Complete'),
    ]);

    expect(leaderboard.map(({ modelId, rank }) => ({ modelId, rank }))).toEqual([
      { modelId: 'complete', rank: 1 },
      { modelId: 'a-high', rank: null },
      { modelId: 'z-low', rank: null },
    ]);
  });

  it('rejects duplicate model IDs and duplicate arena categories', () => {
    expect(() => buildOverallLeaderboard([model('duplicate', []), model('duplicate', [])])).toThrow(
      /duplicate modelId duplicate/,
    );
    expect(() =>
      buildOverallLeaderboard([
        model('duplicate-arena', [
          { category: 'reasoning', score: 1000, rankedMatches: 1 },
          { category: 'reasoning', score: 1001, rankedMatches: 2 },
        ]),
      ]),
    ).toThrow(/duplicate-arena has duplicate category reasoning/);
  });

  it.each([
    [
      'a non-array model list',
      () => buildOverallLeaderboard({} as unknown as readonly OverallModelScoreInput[]),
      /models must be an array/,
    ],
    [
      'a null model',
      () => buildOverallLeaderboard([null as unknown as OverallModelScoreInput]),
      /model must be an object/,
    ],
    ['a blank model ID', () => buildOverallLeaderboard([model(' ', [])]), /modelId/],
    [
      'a blank display name',
      () => buildOverallLeaderboard([model('blank-name', [], ' ')]),
      /displayName/,
    ],
    [
      'non-array arena scores',
      () =>
        buildOverallLeaderboard([
          {
            modelId: 'bad-arenas',
            displayName: 'Bad arenas',
            arenaScores: {} as unknown as readonly OverallArenaScore[],
          },
        ]),
      /arenaScores must be an array/,
    ],
    [
      'a null arena row',
      () => buildOverallLeaderboard([model('bad-row', [null as unknown as OverallArenaScore])]),
      /invalid arena score/,
    ],
  ])('rejects %s', (_label, run, expected) => {
    expect(run).toThrow(expected);
  });

  it.each(['speed', 'unknown'])('rejects the non-judged category %s', (category) => {
    expect(() =>
      buildOverallLeaderboard([
        model('invalid-category', [
          { category: category as JudgedBenchmarkCategory, score: 1000, rankedMatches: 1 },
        ]),
      ]),
    ).toThrow(/is not a judged overall category/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite arena score %s',
    (score) => {
      expect(() =>
        buildOverallLeaderboard([
          model('invalid-score', [{ category: 'reasoning', score, rankedMatches: 1 }]),
        ]),
      ).toThrow(/score must be finite/);
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid observed match count %s',
    (rankedMatches) => {
      expect(() =>
        buildOverallLeaderboard([
          model('invalid-matches', [{ category: 'reasoning', score: 1000, rankedMatches }]),
        ]),
      ).toThrow(/rankedMatches must be a positive safe integer/);
    },
  );
});
