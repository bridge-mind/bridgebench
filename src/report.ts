import { ELO_INITIAL, ELO_K } from './elo.js';
import { getModel, listModels } from './models.js';
import {
  CATEGORY_META,
  METHODOLOGY_VERSION,
  type ArenaSnapshot,
  type BenchmarkCategory,
  type LeaderboardEntry,
  type MatchResult,
} from './types.js';

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

export function buildSnapshot(matches: MatchResult[], category: BenchmarkCategory): ArenaSnapshot {
  const entries = new Map<string, Omit<LeaderboardEntry, 'rank'>>();
  for (const model of listModels('competitor')) {
    entries.set(model.id, {
      modelId: model.id,
      displayName: model.displayName,
      elo: ELO_INITIAL,
      points: 0,
      wins: 0,
      losses: 0,
      forfeits: 0,
      matches: 0,
      winRate: 0,
      unanimousWins: 0,
      totalCostUsd: 0,
      byCluster: {},
    });
  }

  for (const match of matches) {
    const modelA = entries.get(match.competitors.modelA)!;
    const modelB = entries.get(match.competitors.modelB)!;
    modelA.elo = match.eloAfter[modelA.modelId] ?? modelA.elo;
    modelB.elo = match.eloAfter[modelB.modelId] ?? modelB.elo;
    modelA.totalCostUsd += match.competitors.responseA.costUsd;
    modelB.totalCostUsd += match.competitors.responseB.costUsd;
    if (match.outcome === 'no-contest' || !match.winnerModelId) continue;
    modelA.matches += 1;
    modelB.matches += 1;
    const winner = entries.get(match.winnerModelId)!;
    const loser = match.winnerModelId === modelA.modelId ? modelB : modelA;
    winner.points += 1;
    winner.wins += 1;
    loser.losses += 1;
    if (match.outcome === 'forfeit') loser.forfeits += 1;
    if (match.panel?.agreement === 'unanimous') winner.unanimousWins += 1;
    const cluster = match.task.cluster;
    winner.byCluster[cluster] = incrementCluster(winner.byCluster[cluster], 'wins');
    loser.byCluster[cluster] = incrementCluster(loser.byCluster[cluster], 'losses');
  }

  const leaderboard = [...entries.values()]
    .map((entry) => ({
      ...entry,
      elo: round(entry.elo),
      winRate: entry.matches === 0 ? 0 : round((entry.wins / entry.matches) * 100, 1),
      totalCostUsd: round(entry.totalCostUsd, 6),
    }))
    .sort((a, b) => b.elo - a.elo || b.points - a.points || a.displayName.localeCompare(b.displayName))
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  return {
    version: '0.2.0',
    methodologyVersion: METHODOLOGY_VERSION,
    category,
    generatedAt: new Date().toISOString(),
    initialElo: ELO_INITIAL,
    kFactor: ELO_K,
    leaderboard,
    matches,
  };
}

function incrementCluster(
  current: { wins: number; losses: number } | undefined,
  field: 'wins' | 'losses',
): { wins: number; losses: number } {
  const next = current ?? { wins: 0, losses: 0 };
  return { ...next, [field]: next[field] + 1 };
}

export function renderMarkdown(snapshot: ArenaSnapshot): string {
  const meta = CATEGORY_META[snapshot.category];
  const rows = snapshot.leaderboard.map((entry) =>
    `| ${entry.rank} | ${entry.displayName} | ${entry.elo.toFixed(2)} | ${entry.points} | ${entry.wins}-${entry.losses} | ${entry.forfeits} | ${entry.winRate.toFixed(1)}% | $${entry.totalCostUsd.toFixed(4)} |`,
  );
  const recent = snapshot.matches.slice(-20).reverse().map((match) => {
    const a = getModel(match.competitors.modelA).displayName;
    const b = getModel(match.competitors.modelB).displayName;
    const winner = match.winnerModelId ? getModel(match.winnerModelId).displayName : 'No contest';
    return `| ${match.task.id} | ${a} vs ${b} | ${winner} | ${match.outcome} | $${match.matchCostUsd.toFixed(4)} |`;
  });
  return `# BridgeBench V3 ${meta.label} Arena\n\n` +
    `${meta.tagline}\n\n` +
    `Generated ${snapshot.generatedAt}. Ratings start at ${snapshot.initialElo} with K=${snapshot.kFactor}.\n\n` +
    `## Leaderboard\n\n| Rank | Model | Elo | Points | W-L | Forfeits | Win rate | Competitor cost |\n` +
    `|---:|---|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` +
    `## Recent matches\n\n| Task | Matchup | Winner | Outcome | Total cost |\n|---|---|---|---|---:|\n` +
    `${recent.join('\n') || '| — | — | — | — | — |'}\n`;
}

export function writeReports(store: {
  category: BenchmarkCategory;
  readAll(): MatchResult[];
  writeSnapshot(s: ArenaSnapshot): void;
  writeMarkdown(s: string): void;
}): ArenaSnapshot {
  const snapshot = buildSnapshot(store.readAll(), store.category);
  store.writeSnapshot(snapshot);
  store.writeMarkdown(renderMarkdown(snapshot));
  return snapshot;
}
