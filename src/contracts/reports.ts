import type { BenchmarkCategory } from './categories.js';
import type { MatchResult } from './journal.js';

/** Per-model latency aggregates surfaced by the speed arena, derived from decided matches. */
export interface SpeedStats {
  /** Number of speed-decided matches this model participated in. */
  samples: number;
  medianTtftMs: number;
  avgTtftMs: number;
  medianTps: number;
  avgTps: number;
}

export interface LeaderboardEntry {
  /** Null until the model has a decided ranked match in this arena. */
  rank: number | null;
  status: 'ranked' | 'unranked';
  modelId: string;
  displayName: string;
  elo: number;
  points: number;
  wins: number;
  losses: number;
  forfeits: number;
  matches: number;
  winRate: number;
  unanimousWins: number;
  totalCostUsd: number;
  byCluster: Partial<Record<string, { wins: number; losses: number }>>;
  /** Present only for the speed category; omitted for judged categories so their output is unchanged. */
  speed?: SpeedStats;
}

export interface ArenaSnapshot {
  version: '0.3.0';
  methodologyVersion: string;
  category: BenchmarkCategory;
  generatedAt: string;
  initialElo: number;
  kFactor: number;
  leaderboard: LeaderboardEntry[];
  matches: MatchResult[];
}
