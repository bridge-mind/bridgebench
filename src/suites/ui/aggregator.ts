/**
 * Builds the snapshot (v3) from journal results: dedupe to the latest result
 * per (model, task), aggregate per-model summaries across the five scoring
 * dimensions, and rank the leaderboard by harness score. Every snapshot is
 * stamped with its season and engine pins — results from different seasons
 * are never mixed.
 */

import { SEASON, THREE_VERSION } from '../../config.js';
import {
  SCORING_WEIGHTS,
  UI_TASK_CATEGORIES,
  type UiBenchLeaderboardEntry,
  type UiBenchModelSummary,
  type UiBenchSnapshot,
  type UiBenchTaskResult,
} from './types.js';

const ENGINE_VERSION = '3.0.0-alpha.0';

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function resultTimestamp(result: UiBenchTaskResult): number {
  const parsed = Date.parse(result.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dedupeResults(results: UiBenchTaskResult[]): UiBenchTaskResult[] {
  const latestByTask = new Map<string, UiBenchTaskResult>();

  for (const result of results) {
    const key = `${result.modelId}::${result.taskId}`;
    const previous = latestByTask.get(key);
    if (!previous || resultTimestamp(result) >= resultTimestamp(previous)) {
      latestByTask.set(key, result);
    }
  }

  return Array.from(latestByTask.values()).sort((left, right) => {
    if (left.modelId !== right.modelId) return left.modelId.localeCompare(right.modelId);
    return left.taskId.localeCompare(right.taskId);
  });
}

export function aggregateUiBenchModel(results: UiBenchTaskResult[]): UiBenchModelSummary {
  const successfulTasks = results.filter((r) => r.success).length;
  const totalTasks = results.length;

  const byCategory = Object.fromEntries(
    UI_TASK_CATEGORIES.map((category) => {
      const catResults = results.filter((r) => r.category === category);
      return [
        category,
        {
          averageScore:
            catResults.length === 0 ? 0 : round1(avg(catResults.map((r) => r.scores.total))),
          tasks: catResults.length,
        },
      ];
    }),
  );

  return {
    modelId: results[0]?.modelId ?? '',
    displayName: results[0]?.displayName ?? '',
    totalTasks,
    successfulTasks,
    failedTasks: totalTasks - successfulTasks,
    successRate: totalTasks === 0 ? 0 : round1((successfulTasks / totalTasks) * 100),
    harnessScore: totalTasks === 0 ? 0 : round1(avg(results.map((r) => r.scores.total))),
    avgRenderIntegrity: round1(avg(results.map((r) => r.scores.renderIntegrity))),
    avgMotion: round1(avg(results.map((r) => r.scores.motion))),
    avgInteraction: round1(avg(results.map((r) => r.scores.interaction))),
    avgDeterminism: round1(avg(results.map((r) => r.scores.determinism))),
    avgSpecAdherence: round1(avg(results.map((r) => r.scores.specAdherence))),
    interactionPartial: results.some((r) => r.scores.interactionPartial),
    totalCostUsd: Number(results.reduce((sum, r) => sum + r.costUsd, 0).toFixed(6)),
    averageProviderResponseMs:
      totalTasks === 0 ? 0 : round1(avg(results.map((r) => r.providerResponseMs))),
    byCategory,
  };
}

export function buildUiBenchSnapshot(
  results: UiBenchTaskResult[],
  taskIds: string[],
  modelIds: string[],
): UiBenchSnapshot {
  const seasonResults = results.filter((r) => r.season === SEASON.id);
  const deduped = dedupeResults(seasonResults);

  const grouped = new Map<string, UiBenchTaskResult[]>();
  for (const result of deduped) {
    const list = grouped.get(result.modelId) ?? [];
    list.push(result);
    grouped.set(result.modelId, list);
  }

  const summaries = Array.from(grouped.entries()).map(([modelId, modelResults]) => ({
    modelId,
    summary: aggregateUiBenchModel(modelResults),
    results: modelResults,
  }));

  const leaderboard: UiBenchLeaderboardEntry[] = summaries
    .sort((left, right) => right.summary.harnessScore - left.summary.harnessScore)
    .map((entry, index) => ({
      rank: index + 1,
      modelId: entry.modelId,
      displayName: entry.summary.displayName,
      harnessScore: entry.summary.harnessScore,
      renderIntegrityScore: entry.summary.avgRenderIntegrity,
      motionScore: entry.summary.avgMotion,
      interactionScore: entry.summary.avgInteraction,
      determinismScore: entry.summary.avgDeterminism,
      specAdherenceScore: entry.summary.avgSpecAdherence,
      totalTasks: entry.summary.totalTasks,
      successRate: entry.summary.successRate,
      elo: null,
    }));

  return {
    version: '3.0.0',
    suite: 'ui',
    generatedAt: new Date().toISOString(),
    season: {
      id: SEASON.id,
      name: SEASON.name,
      startsAt: SEASON.startsAt,
      endsAt: SEASON.endsAt,
    },
    engine: {
      engineVersion: ENGINE_VERSION,
      threeVersion: THREE_VERSION,
      weights: SCORING_WEIGHTS,
    },
    config: {
      totalTasks: taskIds.length,
      taskIds,
      modelIds,
    },
    leaderboard,
    models: Object.fromEntries(
      summaries.map((entry) => [
        entry.modelId,
        { summary: entry.summary, results: entry.results },
      ]),
    ),
  };
}
