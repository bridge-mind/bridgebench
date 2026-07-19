/**
 * UI Bench publish glue: journals local `ui evaluate` outcomes and pushes the
 * journal — with artifact HTML and screenshots inlined — to the bridgebench.ai
 * API (`POST /ui-bench/results/import`, admin-key guarded, idempotent on
 * content hashes). The local journal is the execution authority; the API is a
 * one-way published replica.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

import {
  delay,
  postJson,
  resolveApiConfig,
  REQUEST_SPACING_MS,
  type ApiConfig,
} from '../../api-client.js';
import { RESULTS_DIR, TASKS_DIR, THREE_VERSION } from '../../config.js';
import { ENGINE_VERSION } from '../../version.js';
import { UiBenchResultStore } from './result-store.js';
import { UiTaskLoader } from './task-loader.js';
import {
  artifactSlug,
  type UiArtifactEvaluationResult,
  type UiArtifactValidationResult,
  type UiBenchFullTask,
  type UiBenchTaskResult,
  type UiQualification,
} from './types.js';

/**
 * Results roots resolve at call time (not import time) so the API-spawned
 * runner's BRIDGEBENCH_RESULTS_DIR — set after module load by the parent
 * process env — is honored, and so mock runs journal into their own subtree
 * (a shared journal would let a later live `ui publish` sweep fixture
 * results into the real run).
 */
export function uiResultsRoot(mock = false): string {
  const base = process.env.BRIDGEBENCH_RESULTS_DIR?.trim() || RESULTS_DIR;
  return path.join(base, mock ? 'ui-mock' : 'ui');
}

export function uiJournalPath(root: string = uiResultsRoot()): string {
  return path.join(root, 'journal.jsonl');
}

export function uiSnapshotPath(root: string = uiResultsRoot()): string {
  return path.join(root, 'snapshot.json');
}

export function uiArtifactsDir(root: string = uiResultsRoot()): string {
  return path.join(root, 'artifacts');
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The journal keeps evaluation data, not its bulky capture by-products. */
function omitHeavyEvaluationFields(
  evaluation: UiArtifactEvaluationResult,
): UiBenchTaskResult['evaluation'] {
  const copy: Record<string, unknown> = { ...evaluation };
  delete copy.consoleSample;
  delete copy.screenshots;
  delete copy.browser;
  return copy as UiBenchTaskResult['evaluation'];
}

export interface UiResultMetrics {
  providerResponseMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const ZERO_METRICS: UiResultMetrics = {
  providerResponseMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

export interface JournalUiEvaluationInput {
  task: UiBenchFullTask;
  modelId: string;
  /** Shown on leaderboards; defaults to the model id (`ui evaluate` behavior). */
  displayName?: string;
  /**
   * The normalized HTML that was actually evaluated, or null when the
   * provider call failed and there is no artifact to persist.
   */
  html: string | null;
  validation: UiArtifactValidationResult;
  evaluation: UiArtifactEvaluationResult | null;
  qualification: UiQualification;
  /** Real provider metrics from the live runner; `ui evaluate` journals zeros. */
  metrics?: UiResultMetrics;
  /** Defaults to true — the historical `ui evaluate --journal` semantics. */
  success?: boolean;
  errorType?: string;
  /** Overrides the default results root (live runs, mock runs, tests). */
  resultsRoot?: string;
}

/**
 * Persist one evaluation as a journal line, copying the artifact and its
 * gallery screenshots to stable paths so a later `ui publish` can inline
 * their bytes.
 */
export async function journalUiEvaluation(
  input: JournalUiEvaluationInput,
): Promise<{ journalPath: string; artifactDir: string; line: UiBenchTaskResult }> {
  const root = input.resultsRoot ?? uiResultsRoot();
  const slug = artifactSlug(input.modelId);
  const artifactDir = path.join(uiArtifactsDir(root), input.task.id, slug);

  let htmlPath = '';
  const screenshotPaths: Record<string, string> = {};
  if (input.html !== null) {
    mkdirSync(artifactDir, { recursive: true });
    htmlPath = path.join(artifactDir, 'artifact.html');
    writeFileSync(htmlPath, input.html);
    for (const [name, source] of Object.entries(input.evaluation?.screenshots ?? {})) {
      const target = path.join(artifactDir, `${name}.png`);
      copyFileSync(source, target);
      screenshotPaths[name] = target;
    }
  }

  const evaluation = input.evaluation ? omitHeavyEvaluationFields(input.evaluation) : null;
  const metrics = input.metrics ?? ZERO_METRICS;

  const line: UiBenchTaskResult = {
    modelId: input.modelId,
    displayName: input.displayName ?? input.modelId,
    taskId: input.task.id,
    season: input.task.season,
    category: input.task.category,
    qualification: input.qualification,
    validation: input.validation,
    evaluation,
    providerResponseMs: metrics.providerResponseMs,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    costUsd: metrics.costUsd,
    success: input.success ?? true,
    ...(input.errorType === undefined ? {} : { errorType: input.errorType }),
    timestamp: new Date().toISOString(),
    artifactSha256: input.html === null ? null : sha256Hex(input.html),
    artifactPaths: { html: htmlPath, screenshots: screenshotPaths },
  };

  const journalPath = uiJournalPath(root);
  const store = new UiBenchResultStore({
    journalPath,
    snapshotPath: uiSnapshotPath(root),
  });
  store.open();
  store.append(line);
  await store.close();

  return { journalPath, artifactDir, line };
}

const ImportResponseSchema = z.object({
  importedResults: z.number().int().nonnegative(),
  skippedResults: z.number().int().nonnegative(),
  importedArtifacts: z.number().int().nonnegative(),
});

/** sha256 of the raw public task YAML — the API's task revision identity. */
function taskPublicHash(taskId: string): string {
  const yamlPath = path.join(TASKS_DIR, 'ui', `${taskId}.yaml`);
  return sha256Hex(readFileSync(yamlPath));
}

function taskSpecPayload(task: UiBenchFullTask): Record<string, unknown> {
  return {
    id: task.id,
    season: task.season,
    title: task.title,
    category: task.category,
    requiresWebGL: task.requiresWebGL,
    viewport: task.viewport,
    libraries: task.libraries,
    controls: task.controls,
    screenshots: task.screenshots,
    prompt: task.prompt,
    publicHash: taskPublicHash(task.id),
  };
}

function resultPayload(line: UiBenchTaskResult): Record<string, unknown> {
  const artifactHtml =
    line.artifactSha256 === null ? null : readFileSync(line.artifactPaths.html, 'utf8');
  const screenshots = Object.entries(line.artifactPaths.screenshots).map(([name, file]) => ({
    name,
    pngBase64: readFileSync(file).toString('base64'),
  }));
  return {
    modelId: line.modelId,
    displayName: line.displayName,
    taskId: line.taskId,
    season: line.season,
    category: line.category,
    qualification: line.qualification,
    validation: line.validation,
    evaluation: line.evaluation,
    providerResponseMs: line.providerResponseMs,
    inputTokens: line.inputTokens,
    outputTokens: line.outputTokens,
    costUsd: line.costUsd,
    success: line.success,
    ...(line.errorType === undefined ? {} : { errorType: line.errorType }),
    timestamp: line.timestamp,
    artifactSha256: line.artifactSha256,
    artifactHtml,
    screenshots,
  };
}

/** `ui-s<season>-<yyyymmdd>` from the newest journal timestamp. */
export function defaultUiRunKey(journal: readonly UiBenchTaskResult[]): string {
  const newest = journal
    .map((line) => line.timestamp)
    .sort()
    .at(-1)!;
  const season = journal[journal.length - 1]!.season;
  return `ui-s${season}-${newest.slice(0, 10).replaceAll('-', '')}`;
}

export interface PublishUiResultsOutcome {
  importedResults: number;
  skippedResults: number;
  importedArtifacts: number;
  results: number;
}

export interface UiRunDescriptor {
  runKey: string;
  season: number;
  engineVersion: string;
  threeVersion: string;
}

/** Stamps the engine's own provenance — the API rejects drift per run key. */
export function buildUiRunDescriptor(runKey: string, season: number): UiRunDescriptor {
  return { runKey, season, engineVersion: ENGINE_VERSION, threeVersion: THREE_VERSION };
}

/**
 * Push a single journal line to the API under an already-chosen run identity.
 * The line is the retry payload source: re-posting the same line re-reads the
 * same on-disk bytes, so the request is byte-identical and the server's
 * content-hash idempotency turns retries into skips instead of 409 conflicts.
 */
export async function publishSingleUiResult(
  line: UiBenchTaskResult,
  run: UiRunDescriptor,
  config: ApiConfig,
  taskSpecs?: Map<string, Record<string, unknown>>,
): Promise<PublishUiResultsOutcome> {
  let spec = taskSpecs?.get(line.taskId);
  if (!spec) {
    spec = taskSpecPayload(await new UiTaskLoader().loadById(line.taskId));
    taskSpecs?.set(line.taskId, spec);
  }
  const body = { run, tasks: [spec], results: [resultPayload(line)] };
  const response = await postJson(config, '/ui-bench/results/import', body, ImportResponseSchema);
  return { ...response, results: 1 };
}

/**
 * Push every journal line to the API, one result per request (artifact bytes
 * ride along inline). Idempotent server-side: re-publishing an unchanged
 * journal reports everything skipped.
 */
export async function publishUiResults(
  options: { runKey?: string; journalPath?: string } = {},
  config: ApiConfig = resolveApiConfig(),
): Promise<PublishUiResultsOutcome> {
  const store = new UiBenchResultStore({
    journalPath: options.journalPath ?? uiJournalPath(),
    snapshotPath: uiSnapshotPath(),
  });
  const appendOnly = await store.readJournal();
  // The journal is append-only; a re-evaluated (task, model) pair supersedes
  // its earlier line, so only the newest revision is published.
  const latestByKey = new Map<string, UiBenchTaskResult>();
  for (const line of appendOnly) {
    latestByKey.set(`${line.taskId}::${line.modelId}`, line);
  }
  const journal = [...latestByKey.values()];
  if (journal.length === 0) {
    return {
      importedResults: 0,
      skippedResults: 0,
      importedArtifacts: 0,
      results: 0,
    };
  }

  const runKey = options.runKey ?? defaultUiRunKey(journal);
  const run = buildUiRunDescriptor(runKey, journal[journal.length - 1]!.season);

  const loader = new UiTaskLoader();
  const specsByTask = new Map<string, Record<string, unknown>>();
  for (const line of journal) {
    if (!specsByTask.has(line.taskId)) {
      specsByTask.set(line.taskId, taskSpecPayload(await loader.loadById(line.taskId)));
    }
  }

  let importedResults = 0;
  let skippedResults = 0;
  let importedArtifacts = 0;
  let first = true;
  for (const line of journal) {
    if (!first) await delay(REQUEST_SPACING_MS);
    first = false;
    const response = await publishSingleUiResult(line, run, config, specsByTask);
    importedResults += response.importedResults;
    skippedResults += response.skippedResults;
    importedArtifacts += response.importedArtifacts;
  }

  return {
    importedResults,
    skippedResults,
    importedArtifacts,
    results: journal.length,
  };
}
