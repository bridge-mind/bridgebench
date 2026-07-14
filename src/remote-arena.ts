import path from 'node:path';

import { z } from 'zod';

import { getJson, postJson, type ApiConfig } from './api-client.js';
import { publishJournalFromStore } from './publish.js';
import { ArenaRunner } from './arena.js';
import { noopLogger, type ArenaLogger } from './logger.js';
import { MockOpenRouterGateway } from './mock-gateway.js';
import { OpenRouterClient } from './openrouter.js';
import { resolveCompetitorRoster } from './models.js';
import { RemoteArenaEventSink } from './remote-events.js';
import { createRunManifest, runIdFromManifest, runManifestHash } from './run-manifest.js';
import { ArenaStore } from './store.js';
import { TASKS_PER_CATEGORY } from './tasks.js';
import {
  METHODOLOGY_VERSION,
  type ArenaRunConfig,
  type ArenaTask,
  type BenchmarkCategory,
  type MatchResult,
  type OpenRouterGateway,
} from './types.js';

const TaskArtifactSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  content: z.string(),
});

// A public-only pack (the speed arena) omits the hidden half: `private` is null
// and `privateHash` is null. Judged packs carry both.
const ExecutionPackTaskSchema = z.object({
  public: z.object({
    id: z.string(),
    version: z.string(),
    category: z.string(),
    cluster: z.string(),
    difficulty: z.string(),
    title: z.string(),
    summary: z.string(),
    prompt: z.string(),
    artifacts: z.array(TaskArtifactSchema),
    tags: z.array(z.string()).optional(),
  }),
  private: z
    .object({
      id: z.string(),
      version: z.string(),
      expectedResolution: z.string(),
      requiredEvidence: z.array(z.string()),
      disqualifyingErrors: z.array(z.string()),
      rubric: z.record(z.unknown()),
    })
    .nullable(),
  publicHash: z.string(),
  privateHash: z.string().nullable(),
});

const ExecutionPackSchema = z.object({
  category: z.string(),
  methodologyVersion: z.string(),
  competitors: z.array(z.unknown()),
  judges: z.array(z.unknown()),
  // Pack size follows TASKS_PER_CATEGORY (18 = 6 clusters × 3).
  tasks: z.array(ExecutionPackTaskSchema).length(TASKS_PER_CATEGORY),
});

const CreateRunResponseSchema = z.object({
  created: z.boolean(),
  run: z.object({
    runKey: z.string(),
    status: z.string(),
  }),
});

export interface RemoteArenaRunOptions {
  config: ArenaRunConfig;
  mock?: boolean;
  publishMatches?: boolean;
  logger?: ArenaLogger;
}

export interface RemoteArenaRunResult {
  runKey: string;
  completed: number;
  costUsd: number;
  cancelled: boolean;
  stoppedForBudget: boolean;
}

function remoteStoreConfig(category: BenchmarkCategory, root: string) {
  return {
    category,
    journalPath: path.join(root, 'journal.jsonl'),
    snapshotPath: path.join(root, 'snapshot.json'),
    markdownPath: path.join(root, 'leaderboard.md'),
    runsDir: path.join(root, 'runs'),
  };
}

export async function fetchExecutionPack(
  config: ApiConfig,
  category: BenchmarkCategory,
): Promise<{ tasks: ArenaTask[] }> {
  const pack = await getJson(
    config,
    `/arena/admin/${category}/execution-pack`,
    ExecutionPackSchema,
  );
  if (pack.methodologyVersion !== METHODOLOGY_VERSION) {
    throw new Error(
      `Execution pack methodology ${pack.methodologyVersion} does not match engine ${METHODOLOGY_VERSION}`,
    );
  }
  return { tasks: pack.tasks as ArenaTask[] };
}

export async function createRemoteRun(
  apiConfig: ApiConfig,
  runConfig: ArenaRunConfig,
  tasks: readonly ArenaTask[],
): Promise<{ runKey: string; created: boolean }> {
  const manifest = createRunManifest(runConfig, [...tasks]);
  const manifestHash = runManifestHash(manifest);
  const runKey = runIdFromManifest(manifest);
  const competitorIds = resolveCompetitorRoster(runConfig.competitorIds).map((model) => model.id);
  const body = {
    runKey,
    category: runConfig.category,
    seed: runConfig.seed,
    methodologyVersion: METHODOLOGY_VERSION,
    competitorIds,
    scheduledCount: runConfig.matches,
    maxCostUsd: runConfig.maxCostUsd,
    manifest,
    manifestHash,
  };
  const response = await postJson(apiConfig, '/arena/admin/runs', body, CreateRunResponseSchema);
  return { runKey: response.run.runKey, created: response.created };
}

/**
 * Mock verdicts never reach the public ladder, even when a caller forgets
 * --no-publish-matches.
 */
export function shouldPublishRemoteMatches(mock: boolean, publishMatches = true): boolean {
  return publishMatches && !mock;
}

/**
 * Mock journals live in their own subtree. A shared journal would let the
 * next live run read and publish deterministic fake verdicts wholesale —
 * exactly what --no-publish-matches exists to prevent.
 */
export function remoteResultsRoot(category: BenchmarkCategory, mock: boolean): string {
  return path.join(
    process.env.BRIDGEBENCH_RESULTS_DIR?.trim() || path.join(process.cwd(), 'results'),
    mock ? 'remote-mock' : 'remote',
    category,
  );
}

export async function runRemoteArena(
  apiConfig: ApiConfig,
  options: RemoteArenaRunOptions,
): Promise<RemoteArenaRunResult> {
  const { config, mock = false, logger = noopLogger } = options;
  const publishMatches = shouldPublishRemoteMatches(mock, options.publishMatches);
  const { tasks } = await fetchExecutionPack(apiConfig, config.category);
  const { runKey } = await createRemoteRun(apiConfig, config, tasks);

  const resultsRoot = remoteResultsRoot(config.category, mock);
  const store = new ArenaStore(remoteStoreConfig(config.category, resultsRoot));
  const eventSink = new RemoteArenaEventSink(apiConfig, runKey, (message, fatal) => {
    logger.warn(fatal ? 'events.mirror-degraded' : 'events.flush-retry', { message });
  });
  const gateway: OpenRouterGateway = mock
    ? new MockOpenRouterGateway({ judgeWinner: 'MODEL_A' })
    : new OpenRouterClient(process.env.OPENROUTER_API_KEY ?? '', logger);

  const runner = new ArenaRunner(gateway, store, eventSink.sink, logger);
  const cancellation = new AbortController();
  const requestCancellation = (): void => {
    if (cancellation.signal.aborted) return;
    cancellation.abort();
  };
  process.once('SIGINT', requestCancellation);

  // Publish after every match so the leaderboard updates per match instead of
  // at run end. The full journal is pushed each time (import skips
  // already-stored match keys) because the API's Elo verification replays the
  // whole history — a lone match whose eloBefore continues from unpublished
  // local matches would be rejected. Failures are logged and retried by the
  // end-of-run sweep below.
  let incrementalPublishFailed = false;
  const onMatchResult = publishMatches
    ? async (result: MatchResult): Promise<void> => {
        try {
          await publishJournalFromStore(store, apiConfig);
        } catch (error) {
          incrementalPublishFailed = true;
          logger.warn('publish.match-failed', {
            matchId: result.matchId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    : undefined;

  try {
    const result = await runner.run(config, tasks, {
      signal: cancellation.signal,
      onMatchResult,
    });
    await eventSink.close();

    // Sweep for anything the incremental path missed (idempotent re-import).
    if (publishMatches && result.completed > 0 && incrementalPublishFailed) {
      await publishJournalFromStore(store, apiConfig);
    }

    return {
      runKey,
      completed: result.completed,
      costUsd: result.costUsd,
      cancelled: result.cancelled,
      stoppedForBudget: result.stoppedForBudget,
    };
  } finally {
    process.removeListener('SIGINT', requestCancellation);
    await eventSink.close();
  }
}

export { publishTarget } from './api-client.js';
