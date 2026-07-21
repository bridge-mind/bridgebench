import {
  JUDGED_CATEGORIES,
  type JudgedBenchmarkCategory,
  type OverallArenaScore,
  type OverallLeaderboardEntry,
  type OverallModelScoreInput,
} from './contracts/overall.js';

export {
  JUDGED_CATEGORIES,
  OVERALL_SCORER_VERSION,
  type JudgedBenchmarkCategory,
  type OverallArenaScore,
  type OverallCoverage,
  type OverallLeaderboardEntry,
  type OverallModelScoreInput,
} from './contracts/overall.js';

const JUDGED_CATEGORY_SET = new Set<string>(JUDGED_CATEGORIES);

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareIdentity(
  left: Pick<OverallLeaderboardEntry, 'displayName' | 'modelId'>,
  right: Pick<OverallLeaderboardEntry, 'displayName' | 'modelId'>,
): number {
  return (
    compareText(left.displayName, right.displayName) || compareText(left.modelId, right.modelId)
  );
}

function requireNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function meanArenaScore(arenaScores: readonly OverallArenaScore[]): number {
  const scale = Math.max(...arenaScores.map((arena) => Math.abs(arena.score)));
  if (scale === 0) return 0;
  const normalizedMean =
    arenaScores.reduce((sum, arena) => sum + arena.score / scale, 0) / arenaScores.length;
  return normalizedMean * scale;
}

function normalizeArenaScores(model: OverallModelScoreInput): OverallArenaScore[] {
  if (!Array.isArray(model.arenaScores)) {
    throw new TypeError(`${model.modelId}.arenaScores must be an array`);
  }

  const byCategory = new Map<JudgedBenchmarkCategory, OverallArenaScore>();
  for (const arena of model.arenaScores) {
    if (!arena || typeof arena !== 'object') {
      throw new TypeError(`${model.modelId} has an invalid arena score`);
    }
    if (!JUDGED_CATEGORY_SET.has(arena.category)) {
      throw new TypeError(
        `${model.modelId} category ${String(arena.category)} is not a judged overall category`,
      );
    }
    if (byCategory.has(arena.category)) {
      throw new TypeError(`${model.modelId} has duplicate category ${arena.category}`);
    }
    if (!Number.isFinite(arena.score)) {
      throw new TypeError(`${model.modelId} ${arena.category} score must be finite`);
    }
    if (!Number.isSafeInteger(arena.rankedMatches) || arena.rankedMatches <= 0) {
      throw new TypeError(
        `${model.modelId} ${arena.category} rankedMatches must be a positive safe integer`,
      );
    }
    byCategory.set(arena.category, {
      category: arena.category,
      score: arena.score,
      rankedMatches: arena.rankedMatches,
    });
  }

  return JUDGED_CATEGORIES.flatMap((category) => {
    const arena = byCategory.get(category);
    return arena ? [arena] : [];
  });
}

/**
 * Builds the shared seven-arena leaderboard without inventing neutral evidence.
 *
 * Callers supply already-normalized contributions for observed arenas only;
 * they remain responsible for deriving each score and ranked-match count.
 * A model receives an overall score and rank only after all seven judged arenas
 * are present; incomplete models remain provisional regardless of partial scores.
 */
export function buildOverallLeaderboard(
  models: readonly OverallModelScoreInput[],
): OverallLeaderboardEntry[] {
  if (!Array.isArray(models)) throw new TypeError('models must be an array');

  const modelIds = new Set<string>();
  const entries = Array.from(models, (model): OverallLeaderboardEntry => {
    if (!model || typeof model !== 'object') throw new TypeError('model must be an object');
    requireNonEmptyString(model.modelId, 'modelId');
    requireNonEmptyString(model.displayName, `${model.modelId}.displayName`);
    if (modelIds.has(model.modelId)) throw new TypeError(`duplicate modelId ${model.modelId}`);
    modelIds.add(model.modelId);

    const arenaScores = normalizeArenaScores(model);
    const observed = new Set(arenaScores.map((arena) => arena.category));
    const missingCategories = JUDGED_CATEGORIES.filter((category) => !observed.has(category));
    const complete = missingCategories.length === 0;
    const overallScore = complete ? meanArenaScore(arenaScores) : null;
    if (overallScore !== null && !Number.isFinite(overallScore)) {
      throw new RangeError(`${model.modelId} overall score is outside the finite number range`);
    }

    return {
      modelId: model.modelId,
      displayName: model.displayName,
      arenaScores,
      coverage: {
        observed: arenaScores.length,
        required: JUDGED_CATEGORIES.length,
        missingCategories,
      },
      status: complete ? 'ranked' : 'provisional',
      overallScore,
      rank: null,
    };
  });

  entries.sort((left, right) => {
    if (left.status !== right.status) return left.status === 'ranked' ? -1 : 1;
    if (left.status === 'ranked' && right.status === 'ranked') {
      const scoreOrder = right.overallScore! - left.overallScore!;
      if (scoreOrder !== 0) return scoreOrder;
    }
    return compareIdentity(left, right);
  });

  let nextRank = 1;
  return entries.map((entry) =>
    entry.status === 'ranked' ? { ...entry, rank: nextRank++ } : entry,
  );
}
