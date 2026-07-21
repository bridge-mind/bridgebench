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
  type SpeedMetric,
  type SpeedStats,
} from './types.js';
import { verifyJournal, type VerificationOptions } from './verification.js';

interface SpeedSample {
  ttftMs: number[];
  tps: number[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectSpeedSample(
  samples: Map<string, SpeedSample>,
  modelId: string,
  metric: SpeedMetric,
): void {
  const existing = samples.get(modelId) ?? { ttftMs: [], tps: [] };
  existing.ttftMs.push(metric.ttftMs);
  existing.tps.push(metric.tps);
  samples.set(modelId, existing);
}

function speedStats(sample: SpeedSample | undefined): SpeedStats {
  const ttftMs = sample?.ttftMs ?? [];
  const tps = sample?.tps ?? [];
  return {
    samples: ttftMs.length,
    medianTtftMs: round(median(ttftMs), 1),
    avgTtftMs: round(average(ttftMs), 1),
    medianTps: round(median(tps), 2),
    avgTps: round(average(tps), 2),
  };
}

export interface SnapshotOptions extends VerificationOptions {
  /** Seed empty standings with this run roster; defaults to every enabled competitor. */
  competitorIds?: readonly string[];
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

type LeaderboardEntryDraft = Omit<LeaderboardEntry, 'rank' | 'status'>;

function emptyEntry(modelId: string, displayName: string): LeaderboardEntryDraft {
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
  entries: Map<string, LeaderboardEntryDraft>,
  modelId: string,
): LeaderboardEntryDraft {
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
  options: SnapshotOptions = {},
): ArenaSnapshot {
  const verified = verifyJournal(matches, category, options);
  const entries = new Map<string, LeaderboardEntryDraft>();
  const speedSamples = new Map<string, SpeedSample>();
  const competitorIds = options.competitorIds ?? listModels('competitor').map((model) => model.id);
  for (const modelId of competitorIds) {
    ensureEntry(entries, modelId);
  }

  for (const match of verified.matches) {
    const modelA = ensureEntry(entries, match.competitors.modelA);
    const modelB = ensureEntry(entries, match.competitors.modelB);
    modelA.elo = match.eloAfter[modelA.modelId] ?? modelA.elo;
    modelB.elo = match.eloAfter[modelB.modelId] ?? modelB.elo;
    modelA.totalCostUsd += competitorCost(match.competitors.responseA);
    modelB.totalCostUsd += competitorCost(match.competitors.responseB);
    if (category === 'speed' && match.speedMetrics) {
      collectSpeedSample(speedSamples, modelA.modelId, match.speedMetrics.a);
      collectSpeedSample(speedSamples, modelB.modelId, match.speedMetrics.b);
    }
    if (match.ranked === false || match.outcome === 'no-contest' || !match.winnerModelId) continue;
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
      status: entry.matches === 0 ? ('unranked' as const) : ('ranked' as const),
      elo: round(verified.ratings[entry.modelId] ?? ELO_INITIAL),
      winRate: entry.matches === 0 ? 0 : round((entry.wins / entry.matches) * 100, 1),
      totalCostUsd: round(entry.totalCostUsd, 6),
      // Speed aggregates are surfaced only for the speed category; judged
      // categories keep their existing entry shape unchanged.
      ...(category === 'speed' ? { speed: speedStats(speedSamples.get(entry.modelId)) } : {}),
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ranked' ? -1 : 1;
      if (a.status === 'unranked') {
        return a.displayName.localeCompare(b.displayName) || a.modelId.localeCompare(b.modelId);
      }
      return (
        b.elo - a.elo ||
        b.points - a.points ||
        a.displayName.localeCompare(b.displayName) ||
        a.modelId.localeCompare(b.modelId)
      );
    })
    .map((entry, index) => ({ rank: entry.status === 'ranked' ? index + 1 : null, ...entry }));

  return {
    version: '0.3.0',
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
  const isSpeed = snapshot.category === 'speed';
  const speedHeader = isSpeed ? ' Median TTFT (ms) | Median TPS |' : '';
  const speedAlign = isSpeed ? '---:|---:|' : '';
  const rows = snapshot.leaderboard.map((entry) => {
    const rank = entry.rank ?? '—';
    const base = `| ${rank} | ${entry.displayName} | ${entry.elo.toFixed(2)} | ${entry.points} | ${entry.wins}-${entry.losses} | ${entry.forfeits} | ${entry.winRate.toFixed(1)}% | $${entry.totalCostUsd.toFixed(4)} |`;
    if (!isSpeed) return base;
    const speed = entry.speed;
    const ttft = speed && speed.samples > 0 ? speed.medianTtftMs.toFixed(0) : '—';
    const tps = speed && speed.samples > 0 ? speed.medianTps.toFixed(1) : '—';
    return `${base} ${ttft} | ${tps} |`;
  });
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
    `Generated ${snapshot.generatedAt}. Ratings start at ${snapshot.initialElo} with K=${snapshot.kFactor}. The initial rating is a computational prior; models without a decided ranked match are unranked (—).\n\n` +
    `## Leaderboard\n\n| Rank | Model | Elo | Points | W-L | Forfeits | Win rate | Competitor cost |${speedHeader}\n` +
    `|---:|---|---:|---:|---:|---:|---:|---:|${speedAlign}\n${rows.join('\n')}\n\n` +
    `## Recent matches\n\n| Task | Matchup | Winner | Outcome | Total cost |\n|---|---|---|---|---:|\n` +
    `${recent.join('\n') || '| — | — | — | — | — |'}\n`
  );
}

export function writeReports(
  store: {
    category: BenchmarkCategory;
    readAll(): MatchResult[];
    readRunManifest?(runId: string): import('./run-manifest.js').RunManifest | null;
    writeSnapshot(s: ArenaSnapshot): void;
    writeMarkdown(s: string): void;
  },
  options: SnapshotOptions = {},
): ArenaSnapshot {
  const snapshot = buildSnapshot(store.readAll(), store.category, {
    ...options,
    manifestForRun: store.readRunManifest ? (runId) => store.readRunManifest!(runId) : undefined,
    requireManifests: Boolean(store.readRunManifest),
  });
  store.writeSnapshot(snapshot);
  store.writeMarkdown(renderMarkdown(snapshot));
  return snapshot;
}
