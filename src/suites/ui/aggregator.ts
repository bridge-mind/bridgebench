/**
 * Builds the snapshot (v3) from journal results: dedupe to the latest result
 * per (model, task) and aggregate per-model ARENA ELIGIBILITY. There is no
 * machine ranking — grading happens through community voting (Elo) on
 * bridgebench.ai, and engine snapshots carry `elo: null` placeholders the
 * site fills from the voting API. Every snapshot is season-stamped; results
 * from different seasons are never mixed.
 */

import { SEASON, THREE_VERSION } from '../../config.js';
import { ENGINE_VERSION } from '../../version.js';
import {
  UI_TASK_CATEGORIES,
  type UiBenchLeaderboardEntry,
  type UiBenchModelSummary,
  type UiBenchSnapshot,
  type UiBenchTaskResult,
} from './types.js';

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
  const totalTasks = results.length;
  const qualified = results.filter((r) => r.qualification.qualified);
  const fullyInteractive = results.filter(
    (r) =>
      r.qualification.diagnostics.probesTotal !== null &&
      r.qualification.diagnostics.probesTotal > 0 &&
      r.qualification.diagnostics.probesPassed === r.qualification.diagnostics.probesTotal,
  );

  const byCategory = Object.fromEntries(
    UI_TASK_CATEGORIES.map((category) => {
      const catResults = results.filter((r) => r.category === category);
      return [
        category,
        {
          qualified: catResults.filter((r) => r.qualification.qualified).length,
          tasks: catResults.length,
        },
      ];
    }),
  );

  return {
    modelId: results[0]?.modelId ?? '',
    displayName: results[0]?.displayName ?? '',
    totalTasks,
    qualifiedTasks: qualified.length,
    disqualifiedTasks: totalTasks - qualified.length,
    qualifiedRate: totalTasks === 0 ? 0 : round1((qualified.length / totalTasks) * 100),
    fullyInteractiveTasks: fullyInteractive.length,
    probesPartial: results.some((r) => r.qualification.diagnostics.probesPartial),
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

  // Alphabetical roster — deliberately NOT ranked. Rank = community Elo.
  const roster: UiBenchLeaderboardEntry[] = summaries
    .sort((left, right) => left.summary.displayName.localeCompare(right.summary.displayName))
    .map((entry) => ({
      modelId: entry.modelId,
      displayName: entry.summary.displayName,
      qualifiedTasks: entry.summary.qualifiedTasks,
      totalTasks: entry.summary.totalTasks,
      qualifiedRate: entry.summary.qualifiedRate,
      fullyInteractiveTasks: entry.summary.fullyInteractiveTasks,
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
      grading: 'community-elo',
    },
    config: {
      totalTasks: taskIds.length,
      taskIds,
      modelIds,
    },
    roster,
    models: Object.fromEntries(
      summaries.map((entry) => [entry.modelId, { summary: entry.summary, results: entry.results }]),
    ),
  };
}
