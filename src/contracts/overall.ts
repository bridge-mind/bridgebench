import type { BenchmarkCategory } from './categories.js';

/** Version of the public coverage gate, equal-arena aggregation, and ordering contract. */
export const OVERALL_SCORER_VERSION = '1.0.0' as const;

/** The seven judged arenas eligible for the overall leaderboard. Speed is separate. */
export const JUDGED_CATEGORIES = Object.freeze([
  'reasoning',
  'hallucination',
  'security',
  'bullshit',
  'refactoring',
  'debugging',
  'generation',
] as const satisfies readonly BenchmarkCategory[]);

export type JudgedBenchmarkCategory = (typeof JUDGED_CATEGORIES)[number];

/**
 * One publisher-normalized arena contribution. The overall scorer preserves
 * this score; it does not derive the score or verify its journal provenance.
 */
export interface OverallArenaScore {
  category: JudgedBenchmarkCategory;
  score: number;
  /** Caller-asserted positive safe-integer count of ladder-eligible decisions. */
  rankedMatches: number;
}

export interface OverallModelScoreInput {
  modelId: string;
  displayName: string;
  /** Missing arenas are omitted rather than represented by a zero-match prior. */
  arenaScores: readonly OverallArenaScore[];
}

export interface OverallCoverage {
  /** Number of judged arenas with a supplied ladder-eligible contribution. */
  observed: number;
  required: typeof JUDGED_CATEGORIES.length;
  missingCategories: readonly JudgedBenchmarkCategory[];
}

export interface OverallLeaderboardEntry {
  modelId: string;
  displayName: string;
  /** Canonically ordered observed arena contributions. */
  arenaScores: readonly OverallArenaScore[];
  coverage: OverallCoverage;
  status: 'ranked' | 'provisional';
  /** Unrounded equal-arena arithmetic mean for complete coverage; otherwise null. */
  overallScore: number | null;
  /** Ordinal position among complete entries; otherwise null. */
  rank: number | null;
}
