/**
 * UI Bench live-run orchestrator (the `ui run` command body): loops models ×
 * tasks through UiTaskRunner, journals every outcome with real provider
 * metrics, and — with --publish — streams each result to the API as it
 * completes, with an idempotent end-of-run sweep for anything the incremental
 * path missed (mirrors remote-arena's per-match publish).
 *
 * stdout is a supervised interface: the bridgebench-api console spawns this
 * command and tails whole lines into its admin UI, and it parses the first
 * `ui-run scheduled total=<n> models=<m> tasks=<t>` line for run progress.
 * Keep output line-oriented — no ANSI, no emoji, no partial writes.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type { Browser } from 'playwright-core';

import { resolveApiConfig, delay, REQUEST_SPACING_MS, type ApiConfig } from '../../api-client.js';
import { isArenaCancellationError, throwIfCancelled } from '../../cancellation.js';
import { REPO_ROOT, SEASON } from '../../config.js';
import type { ArenaLogger } from '../../logger.js';
import { MockOpenRouterGateway } from '../../mock-gateway.js';
import { OpenRouterClient } from '../../openrouter.js';
import type { ModelRegistryEntry, OpenRouterGateway } from '../../types.js';
import { launchEvalBrowser } from './evaluator/index.js';
import {
  buildUiRunDescriptor,
  journalUiEvaluation,
  publishSingleUiResult,
  uiJournalPath,
  uiResultsRoot,
  uiSnapshotPath,
  type UiRunDescriptor,
} from './publish.js';
import { UiBenchResultStore } from './result-store.js';
import { closeRunLogger, getRunLogger, initRunLogger, type RunLogger } from './run-logger.js';
import { resolveUiModels, UiTaskRunner } from './runner.js';
import { UiArtifactStore } from './store.js';
import { UiTaskLoader } from './task-loader.js';
import { buildUiBenchSkipKey, type UiBenchTaskResult } from './types.js';

export const UI_RUN_KEY_PATTERN = /^ui-[A-Za-z0-9._-]{3,76}$/;

export interface UiRunOptions {
  modelSlugs: string[];
  displayNames?: string[];
  taskIds?: string[];
  publish: boolean;
  runKey?: string;
  resume: boolean;
  dry: boolean;
  mock: boolean;
  maxTokens?: number;
  temperature?: number;
  debug: boolean;
}

export interface UiRunDeps {
  stdout: (line: string) => void;
  gateway?: OpenRouterGateway;
  resolveApiConfig?: () => ApiConfig;
  signal?: AbortSignal;
  launchBrowser?: typeof launchEvalBrowser;
  resultsRoot?: string;
}

export interface UiRunSummary {
  runKey: string;
  completed: number;
  qualified: number;
  skipped: number;
  costUsd: number;
  cancelled: boolean;
  publishedResults: number;
  publishFailures: number;
  publishConflicts: number;
}

/** `ui-s<season>-<yyyymmdd>` — the run identity chosen once at run start. */
export function defaultLiveUiRunKey(now = new Date()): string {
  const key = `ui-s${SEASON.id}-${now.toISOString().slice(0, 10).replaceAll('-', '')}`;
  if (!UI_RUN_KEY_PATTERN.test(key)) throw new Error(`Generated run key is invalid: ${key}`);
  return key;
}

/** Mock results never reach the API, even when a caller passes --publish. */
export function shouldPublishUiResults(mock: boolean, publish: boolean): boolean {
  return publish && !mock;
}

/** OpenRouterClient wants an ArenaLogger; the UI suite runs a RunLogger. */
function asArenaLogger(logger: RunLogger): ArenaLogger {
  return {
    filePath: logger.dir ? path.join(logger.dir, 'run.jsonl') : null,
    debug: (event, data) => logger.debug(event, data),
    info: (event, data) => logger.info(event, data),
    warn: (event, data) => logger.warn(event, data),
    error: (event, data) => logger.error(event, data),
  };
}

function defaultGateway(mock: boolean): OpenRouterGateway {
  if (mock) {
    return new MockOpenRouterGateway({
      competitorText: readFileSync(path.join(REPO_ROOT, 'fixtures', 'golden-correct.html'), 'utf8'),
      // Never 0: the mock's fallback chain treats 0 as unset and restores the
      // 40ms default (~9s for the fixture's ~235 chunks).
      chunkDelayMs: 1,
    });
  }
  return new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '', asArenaLogger(getRunLogger()));
}

function is409Conflict(error: unknown): boolean {
  return error instanceof Error && /→ 409:/.test(error.message);
}

export async function runUiBench(options: UiRunOptions, deps: UiRunDeps): Promise<UiRunSummary> {
  const resultsRoot = deps.resultsRoot ?? uiResultsRoot(options.mock);
  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logger = initRunLogger({
    dir: path.join(resultsRoot, 'logs', `run-${runStamp}`),
    ...(options.debug ? { echoLevel: 'debug' as const } : {}),
  });

  const publishEnabled = shouldPublishUiResults(options.mock, options.publish);
  const runKey = options.runKey ?? defaultLiveUiRunKey();
  let apiConfig: ApiConfig | null = null;
  let run: UiRunDescriptor | null = null;
  if (publishEnabled) {
    apiConfig = (deps.resolveApiConfig ?? resolveApiConfig)();
    run = buildUiRunDescriptor(runKey, SEASON.id);
  }

  const loader = new UiTaskLoader();
  const tasks = options.taskIds?.length
    ? await Promise.all(options.taskIds.map((taskId) => loader.loadById(taskId)))
    : await loader.loadAll();
  const models = resolveUiModels(options.modelSlugs, options.displayNames, {
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });
  const total = models.length * tasks.length;

  // The supervised progress contract: this exact line, first, before any
  // other stdout. The API console derives scheduledCount from it.
  deps.stdout(`ui-run scheduled total=${total} models=${models.length} tasks=${tasks.length}`);
  deps.stdout(
    `UI Bench run ${runKey}: ${models.length} model(s) x ${tasks.length} task(s) ` +
      `(${options.mock ? 'mock' : 'openrouter'}, publish: ${publishEnabled ? 'live' : 'off'}${options.dry ? ', dry' : ''})`,
  );
  if (logger.dir) deps.stdout(`Run log: ${logger.dir}`);
  if (!loader.hasPrivateOverlay()) {
    deps.stdout(
      'BRIDGEBENCH_PRIVATE_DIR not set - hidden interaction probes unavailable; probe diagnostics will be marked partial.',
    );
  }

  logger.info('run.start', {
    runKey,
    season: SEASON.id,
    modelIds: models.map((model) => model.id),
    taskIds: tasks.map((task) => task.id),
    resume: options.resume,
    dry: options.dry,
    mock: options.mock,
    publish: publishEnabled,
    maxTokens: options.maxTokens ?? null,
    temperature: options.temperature ?? null,
    privateOverlay: loader.hasPrivateOverlay(),
    node: process.version,
    platform: process.platform,
  });

  const store = new UiBenchResultStore({
    journalPath: uiJournalPath(resultsRoot),
    snapshotPath: uiSnapshotPath(resultsRoot),
  });
  const skipSet = options.resume ? await store.buildSkipSet() : new Set<string>();

  const gateway = deps.gateway ?? defaultGateway(options.mock);
  const uiTaskRunner = new UiTaskRunner({
    gateway,
    artifactStore: new UiArtifactStore(path.join(resultsRoot, 'runs')),
  });

  let browser: Browser | null = null;
  let executablePath = '';
  // A mid-evaluation SIGINT must unwind inside the supervisor's 30s SIGKILL
  // window; evaluation is not signal-aware, so the abort listener yanks the
  // browser out from under it and the runner maps the crash to cancellation.
  const onAbort = (): void => {
    void browser?.close().catch(() => {});
  };
  if (!options.dry) {
    const launched = await (deps.launchBrowser ?? launchEvalBrowser)();
    browser = launched.browser;
    executablePath = launched.executablePath;
    logger.info('run.browser', { executablePath });
    deps.signal?.addEventListener('abort', onAbort, { once: true });
  }

  const summary: UiRunSummary = {
    runKey,
    completed: 0,
    qualified: 0,
    skipped: 0,
    costUsd: 0,
    cancelled: false,
    publishedResults: 0,
    publishFailures: 0,
    publishConflicts: 0,
  };
  const sweepQueue: UiBenchTaskResult[] = [];
  const taskSpecCache = new Map<string, Record<string, unknown>>();

  const publishLine = async (line: UiBenchTaskResult, label: string): Promise<void> => {
    if (!publishEnabled || !apiConfig || !run) return;
    try {
      const outcome = await publishSingleUiResult(line, run, apiConfig, taskSpecCache);
      summary.publishedResults += 1;
      deps.stdout(
        `${label}: published (${outcome.importedResults} new, ${outcome.skippedResults} already present)`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (is409Conflict(error)) {
        summary.publishConflicts += 1;
        deps.stdout(
          `${label}: publish conflict - (run, task, model) already published with different content; re-run with a fresh --run-key`,
        );
        logger.error('publish.conflict', { task: line.taskId, model: line.modelId, message });
      } else {
        summary.publishFailures += 1;
        sweepQueue.push(line);
        deps.stdout(`${label}: publish failed (will retry at end): ${message}`);
        logger.warn('publish.result-failed', { task: line.taskId, model: line.modelId, message });
      }
    }
  };

  try {
    let index = 0;
    pairs: for (const model of models) {
      for (const task of tasks) {
        index += 1;
        const label = `[${index}/${total}] ${model.id} -> ${task.id}`;
        try {
          throwIfCancelled(deps.signal);
        } catch (error) {
          if (isArenaCancellationError(error)) {
            summary.cancelled = true;
            break pairs;
          }
          throw error;
        }

        if (skipSet.has(buildUiBenchSkipKey(model.id, task.id))) {
          summary.skipped += 1;
          deps.stdout(`${label}: skipped (--resume)`);
          logger.info('task.skipped', { model: model.id, task: task.id, reason: 'resume' });
          continue;
        }

        deps.stdout(`${label}: generating...`);
        logger.info('task.start', { model: model.id, task: task.id, dry: options.dry });

        let outcome;
        try {
          outcome = await uiTaskRunner.runTask({
            model,
            task,
            browser,
            executablePath,
            signal: deps.signal,
            onProgress: (phase, detail) => {
              deps.stdout(
                phase === 'evaluating'
                  ? `${label}: evaluating...`
                  : `${label}: generated ${detail}`,
              );
            },
          });
        } catch (error) {
          if (isArenaCancellationError(error)) {
            summary.cancelled = true;
            break pairs;
          }
          throw error;
        }

        const { line } = await journalUiEvaluation({
          task,
          modelId: model.id,
          displayName: model.displayName,
          html: outcome.html,
          validation: outcome.validation,
          evaluation: outcome.evaluation,
          qualification: outcome.qualification,
          metrics: outcome.metrics,
          success: outcome.success,
          errorType: outcome.errorType,
          resultsRoot,
        });
        summary.completed += 1;
        summary.costUsd += outcome.metrics.costUsd;
        if (outcome.qualification.qualified) summary.qualified += 1;

        const diagnostics = outcome.qualification.diagnostics;
        const status = outcome.qualification.qualified
          ? `QUALIFIED (webgl ${diagnostics.webglActive ?? 'none'}, fps ${diagnostics.fps ?? 'n/a'}, ` +
            `probes ${diagnostics.probesPartial ? 'partial' : `${diagnostics.probesPassed}/${diagnostics.probesTotal}`})`
          : `DISQUALIFIED (${outcome.qualification.reasons[0] ?? 'unknown'})` +
            (outcome.errorType ? ` [${outcome.errorType}]` : '');
        deps.stdout(`${label}: ${status}`);
        logger.info('task.result', {
          model: model.id,
          task: task.id,
          qualified: outcome.qualification.qualified,
          reasons: outcome.qualification.reasons,
          errorType: outcome.errorType ?? null,
          costUsd: outcome.metrics.costUsd,
          inputTokens: outcome.metrics.inputTokens,
          outputTokens: outcome.metrics.outputTokens,
          providerResponseMs: outcome.metrics.providerResponseMs,
          finishReason: outcome.finishReason ?? null,
          generationId: outcome.generationId ?? null,
        });

        await publishLine(line, label);
      }
    }
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
    if (browser) await browser.close().catch(() => {});
  }

  // One idempotent sweep for results the incremental path missed. Runs even
  // when cancelled (completed results should land), but stays a single pass
  // so a post-SIGINT shutdown fits the supervisor's escalation window.
  if (sweepQueue.length > 0 && apiConfig && run) {
    deps.stdout(`Retrying ${sweepQueue.length} unpublished result(s)...`);
    let first = true;
    for (const line of sweepQueue) {
      if (!first) await delay(REQUEST_SPACING_MS);
      first = false;
      try {
        await publishSingleUiResult(line, run, apiConfig, taskSpecCache);
        summary.publishedResults += 1;
        summary.publishFailures -= 1;
      } catch (error) {
        logger.warn('publish.sweep-failed', {
          task: line.taskId,
          model: line.modelId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const allTasks = await loader.loadAll();
  await store.rebuildSnapshot(
    allTasks.map((task) => task.id),
    models.map((model: ModelRegistryEntry) => model.id),
  );

  if (summary.cancelled) {
    deps.stdout(
      `Cancelled after ${summary.completed} task(s); completed results remain journaled.`,
    );
  } else {
    deps.stdout(
      `Completed ${summary.completed} task(s): ${summary.qualified} qualified, spend $${summary.costUsd.toFixed(4)}. ` +
        `Journal: ${uiJournalPath(resultsRoot)}`,
    );
  }
  if (publishEnabled) {
    deps.stdout(
      `Published ${summary.publishedResults}/${summary.completed} result(s)` +
        (summary.publishFailures > 0 ? `, ${summary.publishFailures} failed` : '') +
        (summary.publishConflicts > 0 ? `, ${summary.publishConflicts} conflicted` : '') +
        ` under run ${runKey}.`,
    );
  }

  logger.info('run.end', { ...summary });
  await closeRunLogger();
  return summary;
}
