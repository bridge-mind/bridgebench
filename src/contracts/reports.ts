import type { BenchmarkCategory } from './categories.js';
import type { MatchResult } from './journal.js';

export interface LeaderboardEntry {
  rank: number;
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
}

export interface ArenaSnapshot {
  version: '0.2.0';
  methodologyVersion: string;
  category: BenchmarkCategory;
  generatedAt: string;
  initialElo: number;
  kFactor: number;
  leaderboard: LeaderboardEntry[];
  matches: MatchResult[];
}
