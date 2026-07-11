import { ELO_INITIAL, ELO_K } from './elo.js';
import { getModel, listModels } from './models.js';
import {
  CATEGORY_META,
  METHODOLOGY_VERSION,
  competitorCost,
  type ArenaSnapshot,
  type BenchmarkCategory,
  type LeaderboardEntry,
  type MatchResult,
} from './types.js';
import { verifyJournal, type VerificationOptions } from './verification.js';

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function emptyEntry(modelId: string, displayName: string): Omit<LeaderboardEntry, 'rank'> {
  return {
    modelId,
    displayName,
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
  };
}

function ensureEntry(
  entries: Map<string, Omit<LeaderboardEntry, 'rank'>>,
  modelId: string,
): Omit<LeaderboardEntry, 'rank'> {
  const existing = entries.get(modelId);
  if (existing) return existing;
  let displayName = modelId;
  try {
    displayName = getModel(modelId).displayName;
  } catch {
    // Historical journals remain readable after a model leaves the live roster.
  }
  const created = emptyEntry(modelId, displayName);
  entries.set(modelId, created);
  return created;
}

export function buildSnapshot(
  matches: MatchResult[],
  category: BenchmarkCategory,
  verificationOptions: VerificationOptions = {},
): ArenaSnapshot {
  const verified = verifyJournal(matches, category, verificationOptions);
  const entries = new Map<string, Omit<LeaderboardEntry, 'rank'>>();
  for (const model of listModels('competitor')) {
    entries.set(model.id, emptyEntry(model.id, model.displayName));
  }

  for (const match of verified.matches) {
    const modelA = ensureEntry(entries, match.competitors.modelA);
    const modelB = ensureEntry(entries, match.competitors.modelB);
    modelA.elo = match.eloAfter[modelA.modelId] ?? modelA.elo;
    modelB.elo = match.eloAfter[modelB.modelId] ?? modelB.elo;
    modelA.totalCostUsd += competitorCost(match.competitors.responseA);
    modelB.totalCostUsd += competitorCost(match.competitors.responseB);
    if (match.outcome === 'no-contest' || !match.winnerModelId) continue;
    modelA.matches += 1;
    modelB.matches += 1;
    const winner = ensureEntry(entries, match.winnerModelId);
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
      elo: round(verified.ratings[entry.modelId] ?? ELO_INITIAL),
      winRate: entry.matches === 0 ? 0 : round((entry.wins / entry.matches) * 100, 1),
      totalCostUsd: round(entry.totalCostUsd, 6),
    }))
    .sort(
      (a, b) => b.elo - a.elo || b.points - a.points || a.displayName.localeCompare(b.displayName),
    )
    .map((entry, index) => ({ rank: index + 1, ...entry }));

  return {
    version: '0.2.0',
    methodologyVersion: verified.methodologyVersion ?? METHODOLOGY_VERSION,
    category,
    generatedAt: new Date().toISOString(),
    initialElo: ELO_INITIAL,
    kFactor: ELO_K,
    leaderboard,
    matches: verified.matches,
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
  const modelNames = new Map(
    snapshot.leaderboard.map((entry) => [entry.modelId, entry.displayName]),
  );
  const rows = snapshot.leaderboard.map(
    (entry) =>
      `| ${entry.rank} | ${entry.displayName} | ${entry.elo.toFixed(2)} | ${entry.points} | ${entry.wins}-${entry.losses} | ${entry.forfeits} | ${entry.winRate.toFixed(1)}% | $${entry.totalCostUsd.toFixed(4)} |`,
  );
  const recent = snapshot.matches
    .slice(-20)
    .reverse()
    .map((match) => {
      const a = modelNames.get(match.competitors.modelA) ?? match.competitors.modelA;
      const b = modelNames.get(match.competitors.modelB) ?? match.competitors.modelB;
      const winner = match.winnerModelId
        ? (modelNames.get(match.winnerModelId) ?? match.winnerModelId)
        : 'No contest';
      return `| ${match.task.id} | ${a} vs ${b} | ${winner} | ${match.outcome} | $${match.matchCostUsd.toFixed(4)} |`;
    });
  return (
    `# BridgeBench V3 ${meta.label} Arena\n\n` +
    `${meta.tagline}\n\n` +
    `Generated ${snapshot.generatedAt}. Ratings start at ${snapshot.initialElo} with K=${snapshot.kFactor}.\n\n` +
    `## Leaderboard\n\n| Rank | Model | Elo | Points | W-L | Forfeits | Win rate | Competitor cost |\n` +
    `|---:|---|---:|---:|---:|---:|---:|---:|\n${rows.join('\n')}\n\n` +
    `## Recent matches\n\n| Task | Matchup | Winner | Outcome | Total cost |\n|---|---|---|---|---:|\n` +
    `${recent.join('\n') || '| — | — | — | — | — |'}\n`
  );
}

export function writeReports(store: {
  category: BenchmarkCategory;
  readAll(): MatchResult[];
  readRunManifest?(runId: string): import('./run-manifest.js').RunManifest | null;
  writeSnapshot(s: ArenaSnapshot): void;
  writeMarkdown(s: string): void;
}): ArenaSnapshot {
  const snapshot = buildSnapshot(store.readAll(), store.category, {
    manifestForRun: store.readRunManifest ? (runId) => store.readRunManifest!(runId) : undefined,
    requireManifests: Boolean(store.readRunManifest),
  });
  store.writeSnapshot(snapshot);
  store.writeMarkdown(renderMarkdown(snapshot));
  return snapshot;
}
