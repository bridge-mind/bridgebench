import { applyEloWin, ELO_INITIAL } from './elo.js';
import { JudgePanel } from './judges.js';
import { noopLogger, type ArenaLogger } from './logger.js';
import {
  ArenaCancellationError,
  isArenaCancellationError,
  throwIfCancelled,
} from './cancellation.js';
import { getModel, listModels, resolveCompetitorRoster } from './models.js';
import { sanitizeError } from './openrouter.js';
import { writeReports } from './report.js';
import { createRunManifest, runIdFromManifest, runManifestHash } from './run-manifest.js';
import { scheduleMatches } from './scheduler.js';
import { decideSpeedMatch } from './speed.js';
import { ArenaStore } from './store.js';
import { buildCompetitorPrompt } from './tasks.js';
import { detectResponseAnomalies } from './triage.js';
import {
  METHODOLOGY_VERSION,
  competitorCost,
  competitorOutputTokens,
  competitorReasoningTokens,
  isCompleteArenaTask,
  type ArenaExecutionOptions,
  type ArenaEventInput,
  type ArenaEventSink,
  type ArenaRunConfig,
  type ArenaRunResult,
  type ArenaTask,
  type CompetitorFailure,
  type CompetitorResponse,
  type MatchResult,
  type ModelRegistryEntry,
  type OpenRouterGateway,
  type ScheduledMatch,
  type SpeedMetrics,
} from './types.js';

/** Matches with at least one failed response at or past this rate halt the run. */
const HEALTH_STOP_MIN_MATCHES = 4;
const HEALTH_STOP_FAILURE_RATE = 0.5;

interface RunProgress {
  costUsd: number;
  completed: number;
  matchesWithFailures: number;
  stoppedForBudget: boolean;
}

interface PreparedRun {
  runId: string;
  manifestHash: string;
  competitors: ModelRegistryEntry[];
  schedule: ScheduledMatch[];
  tasksById: Map<string, ArenaTask>;
  completedIds: Set<string>;
  progress: RunProgress;
}

function failedResponse(modelId: string, error: unknown, latencyMs: number): CompetitorFailure {
  return {
    modelId,
    success: false,
    error: sanitizeError(error),
    latencyMs,
  };
}

export class ArenaRunner {
  private readonly judges: JudgePanel;
  private readonly logger: ArenaLogger;

  constructor(
    private readonly gateway: OpenRouterGateway,
    private readonly store: ArenaStore,
    private readonly onEvent?: ArenaEventSink,
    logger: ArenaLogger = noopLogger,
  ) {
    this.logger = logger;
    this.judges = new JudgePanel(gateway, onEvent, logger);
  }

  private emit(event: ArenaEventInput): void {
    this.onEvent?.({ ...event, timestamp: new Date().toISOString() });
  }

  private observeCancellation(
    runId: string,
    progress: RunProgress,
    signal?: AbortSignal,
  ): { requested: () => void; dispose: () => void } {
    let emitted = false;
    const requested = (): void => {
      if (emitted) return;
      emitted = true;
      this.logger.info('run.cancellation-requested', {
        runId,
        completed: progress.completed,
        costUsd: progress.costUsd,
      });
      this.emit({
        id: `${runId}-cancellation-requested`,
        type: 'run.cancellation-requested',
        data: {
          runId,
          completed: progress.completed,
          costUsd: progress.costUsd,
        },
      });
    };

    if (signal?.aborted) requested();
    else signal?.addEventListener('abort', requested, { once: true });

    return {
      requested,
      dispose: () => signal?.removeEventListener('abort', requested),
    };
  }

  private cancelRun(runId: string, progress: RunProgress): ArenaRunResult {
    this.logger.info('run.cancelled', {
      runId,
      completed: progress.completed,
      costUsd: progress.costUsd,
    });
    this.emit({
      id: `${runId}-cancelled`,
      type: 'run.cancelled',
      data: {
        runId,
        completed: progress.completed,
        costUsd: progress.costUsd,
      },
    });
    return {
      runId,
      completed: progress.completed,
      costUsd: progress.costUsd,
      stoppedForBudget: progress.stoppedForBudget,
      cancelled: true,
    };
  }

  private async prepareRun(
    config: ArenaRunConfig,
    tasks: ArenaTask[],
    signal?: AbortSignal,
  ): Promise<PreparedRun> {
    const competitors = resolveCompetitorRoster(config.competitorIds);
    const competitorIds = competitors.map((model) => model.id);
    const mismatched = tasks.filter((task) => task.public.category !== config.category);
    if (mismatched.length > 0) {
      throw new Error(
        `Run category ${config.category} received tasks from another arena: ${mismatched.map((task) => task.public.id).join(', ')}`,
      );
    }

    const journal = this.store.readAll();
    const incompatible = journal.find((match) => match.methodologyVersion !== METHODOLOGY_VERSION);
    if (incompatible) {
      throw new Error(
        `Cannot append ${METHODOLOGY_VERSION} matches to a ${incompatible.methodologyVersion} journal; archive it and start a new journal`,
      );
    }
    // Fail before model validation or paid work if any existing line is invalid.
    this.store.rebuildEloState(competitorIds);

    const manifest = createRunManifest(config, tasks, competitors);
    const manifestHash = runManifestHash(manifest);
    const runId = runIdFromManifest(manifest);
    const schedule = scheduleMatches({
      category: config.category,
      seed: config.seed,
      count: config.matches,
      modelIds: competitorIds,
      tasks,
      runId,
    });
    const existing = journal.filter((result) => result.runId === runId);
    const prepared: PreparedRun = {
      runId,
      manifestHash,
      competitors,
      schedule,
      tasksById: new Map(tasks.map((task) => [task.public.id, task])),
      completedIds: new Set(journal.map((result) => result.matchId)),
      progress: {
        costUsd: existing.reduce((sum, result) => sum + result.matchCostUsd, 0),
        completed: 0,
        matchesWithFailures: 0,
        stoppedForBudget: false,
      },
    };

    if (signal?.aborted) return prepared;
    // Speed matches never invoke the judge panel, so their liveness check
    // validates competitors only — no need to reach judges that never run.
    const judgesToValidate = config.category === 'speed' ? [] : listModels('judge');
    try {
      await Promise.all(
        [...competitors, ...judgesToValidate].map((model) =>
          this.gateway.validateModel(model, signal),
        ),
      );
    } catch (error) {
      if (signal?.aborted) return prepared;
      throw error;
    }
    if (signal?.aborted) return prepared;
    this.store.writeRunManifest(runId, manifest);
    return prepared;
  }

  async run(
    config: ArenaRunConfig,
    tasks: ArenaTask[],
    execution: ArenaExecutionOptions = {},
  ): Promise<ArenaRunResult> {
    const { signal, onMatchResult } = execution;
    const { runId, manifestHash, competitors, schedule, tasksById, completedIds, progress } =
      await this.prepareRun(config, tasks, signal);
    const competitorIds = competitors.map((model) => model.id);
    const cancellation = this.observeCancellation(runId, progress, signal);

    try {
      if (signal?.aborted) return this.cancelRun(runId, progress);

      this.logger.info('run.started', {
        runId,
        category: config.category,
        seed: config.seed,
        matches: config.matches,
        maxCostUsd: config.maxCostUsd,
        resume: config.resume,
        healthStop: config.healthStop !== false,
        competitorIds,
      });
      this.emit({
        id: `${runId}-started`,
        type: 'run.started',
        data: {
          runId,
          category: config.category,
          seed: config.seed,
          matches: config.matches,
          maxCostUsd: config.maxCostUsd,
          competitorIds,
        },
      });

      for (const match of schedule) {
        if (signal?.aborted) return this.cancelRun(runId, progress);
        if (completedIds.has(match.id)) {
          if (config.resume) continue;
          throw new Error(
            `Match ${match.id} is already journaled; rerun with --resume or choose a new seed`,
          );
        }
        if (progress.costUsd >= config.maxCostUsd) {
          progress.stoppedForBudget = true;
          this.emit({
            id: `${match.runId}-budget-stopped`,
            type: 'run.budget-stopped',
            data: {
              runId: match.runId,
              completed: progress.completed,
              costUsd: progress.costUsd,
              maxCostUsd: config.maxCostUsd,
            },
          });
          break;
        }
        const task = tasksById.get(match.taskId);
        if (!task) throw new Error(`Scheduled task not found: ${match.taskId}`);
        this.emit({
          id: `${match.id}-started`,
          type: 'match.started',
          data: {
            matchId: match.id,
            index: match.index,
            total: schedule.length,
            category: match.category,
            taskId: match.taskId,
            taskTitle: task.public.title,
            modelA: match.modelA,
            modelB: match.modelB,
          },
        });
        let result: MatchResult;
        try {
          result = await this.runMatch(match, task, manifestHash, competitorIds, signal);
        } catch (error) {
          if (signal?.aborted || isArenaCancellationError(error)) {
            cancellation.requested();
            return this.cancelRun(runId, progress);
          }
          throw error;
        }
        if (signal?.aborted) return this.cancelRun(runId, progress);
        this.store.append(result);
        writeReports(this.store, { competitorIds });
        progress.costUsd += result.matchCostUsd;
        progress.completed += 1;
        if (!result.competitors.responseA.success || !result.competitors.responseB.success) {
          progress.matchesWithFailures += 1;
        }
        this.emit({
          id: `${match.id}-completed`,
          type: 'match.completed',
          data: {
            matchId: match.id,
            taskId: match.taskId,
            winnerModelId: result.winnerModelId,
            outcome: result.outcome,
            costUsd: result.matchCostUsd,
            eloAfter: result.eloAfter,
            completed: progress.completed,
            total: schedule.length,
          },
        });
        if (onMatchResult) await onMatchResult(result);
        if (signal?.aborted) return this.cancelRun(runId, progress);
        if (
          config.healthStop !== false &&
          progress.completed >= HEALTH_STOP_MIN_MATCHES &&
          progress.matchesWithFailures / progress.completed >= HEALTH_STOP_FAILURE_RATE
        ) {
          this.logger.error('run.health-stopped', {
            runId,
            completed: progress.completed,
            matchesWithFailures: progress.matchesWithFailures,
            failureRate: progress.matchesWithFailures / progress.completed,
          });
          throw new Error(
            `Run halted after ${progress.completed} matches: ${progress.matchesWithFailures} had failed competitor responses. ` +
              `The provider path is unhealthy, so continuing would journal junk matches. ` +
              `Inspect the run log${this.logger.filePath ? ` at ${this.logger.filePath}` : ''}, fix the cause, ` +
              `then rerun with --resume (or pass --no-health-stop to override).`,
          );
        }
      }

      if (signal?.aborted) return this.cancelRun(runId, progress);
      writeReports(this.store, { competitorIds });
      this.logger.info('run.completed', {
        runId,
        completed: progress.completed,
        matchesWithFailures: progress.matchesWithFailures,
        costUsd: progress.costUsd,
        stoppedForBudget: progress.stoppedForBudget,
        cancelled: false,
      });
      this.emit({
        id: `${runId}-completed`,
        type: 'run.completed',
        data: {
          runId,
          completed: progress.completed,
          costUsd: progress.costUsd,
          stoppedForBudget: progress.stoppedForBudget,
        },
      });
      return {
        runId,
        completed: progress.completed,
        costUsd: progress.costUsd,
        stoppedForBudget: progress.stoppedForBudget,
        cancelled: false,
      };
    } finally {
      cancellation.dispose();
    }
  }

  private async runMatch(
    match: ScheduledMatch,
    task: ArenaTask,
    manifestHash: string,
    competitorIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<MatchResult> {
    throwIfCancelled(signal);
    const state = this.store.rebuildEloState(competitorIds);
    const prompt = buildCompetitorPrompt(task);
    const [responseA, responseB] = await Promise.all([
      this.runCompetitor(match, 'A', prompt, signal),
      this.runCompetitor(match, 'B', prompt, signal),
    ]);
    throwIfCancelled(signal);
    this.inspectResponse(match, responseA);
    this.inspectResponse(match, responseB);
    this.emit({
      id: `${match.id}-competitors-completed`,
      type: 'competitors.completed',
      data: {
        matchId: match.id,
        modelA: {
          success: responseA.success,
          latencyMs: responseA.latencyMs,
          costUsd: competitorCost(responseA),
          outputTokens: competitorOutputTokens(responseA),
          reasoningTokens: competitorReasoningTokens(responseA) ?? null,
        },
        modelB: {
          success: responseB.success,
          latencyMs: responseB.latencyMs,
          costUsd: competitorCost(responseB),
          outputTokens: competitorOutputTokens(responseB),
          reasoningTokens: competitorReasoningTokens(responseB) ?? null,
        },
      },
    });
    throwIfCancelled(signal);
    const eloBefore = {
      [match.modelA]: state.ratings[match.modelA] ?? ELO_INITIAL,
      [match.modelB]: state.ratings[match.modelB] ?? ELO_INITIAL,
    };
    const eloAfter = { ...eloBefore };
    let outcome: MatchResult['outcome'] = 'no-contest';
    let winnerModelId: string | null = null;
    let panel: MatchResult['panel'] = null;
    let speedMetrics: SpeedMetrics | null = null;

    if (task.public.category === 'speed') {
      // Speed arena: no judge panel. The liveness gate handles forfeit /
      // no-contest, and two live competitors are decided deterministically by
      // lower total wall-clock time. This is a completion check with a latency
      // tiebreak — there is no quality judgment.
      const decision = decideSpeedMatch(responseA, responseB, match.modelA, match.modelB);
      outcome = decision.outcome;
      winnerModelId = decision.winnerModelId;
      speedMetrics = decision.speedMetrics;
    } else if (responseA.success !== responseB.success) {
      outcome = 'forfeit';
      winnerModelId = responseA.success ? match.modelA : match.modelB;
    } else if (responseA.success && responseB.success) {
      if (!isCompleteArenaTask(task)) {
        throw new Error(
          `A judged ${task.public.category} match requires a task with its hidden reference`,
        );
      }
      this.emit({
        id: `${match.id}-judging-started`,
        type: 'judging.started',
        data: { matchId: match.id, judges: listModels('judge').map((model) => model.id) },
      });
      panel = await this.judges.judge({ match, task, responseA, responseB }, signal);
      throwIfCancelled(signal);
      if (panel.winnerModelId) {
        outcome = 'judged';
        winnerModelId = panel.winnerModelId;
      }
    }

    if (winnerModelId) {
      const update = applyEloWin(
        eloBefore[match.modelA]!,
        eloBefore[match.modelB]!,
        winnerModelId === match.modelA ? 'a' : 'b',
      );
      eloAfter[match.modelA] = update.ratingA;
      eloAfter[match.modelB] = update.ratingB;
    }

    const judgeCost =
      panel?.votes.reduce((sum, vote) => sum + (vote.completion?.costUsd ?? 0), 0) ?? 0;
    return {
      methodologyVersion: METHODOLOGY_VERSION,
      runId: match.runId,
      runManifestHash: manifestHash,
      matchId: match.id,
      scheduleIndex: match.index,
      seed: match.seed,
      timestamp: new Date().toISOString(),
      task: {
        id: task.public.id,
        version: task.public.version,
        category: task.public.category,
        cluster: task.public.cluster,
        publicHash: task.publicHash,
        privateHash: task.privateHash,
      },
      competitors: { modelA: match.modelA, modelB: match.modelB, responseA, responseB },
      outcome,
      winnerModelId,
      panel,
      speedMetrics,
      eloBefore,
      eloAfter,
      pointAwarded: winnerModelId !== null,
      matchCostUsd: competitorCost(responseA) + competitorCost(responseB) + judgeCost,
    };
  }

  /** Surface signals that make a journaled response untrustworthy or a task too easy. */
  private inspectResponse(match: ScheduledMatch, response: CompetitorResponse): void {
    if (!response.success) {
      this.logger.warn('competitor.failed', {
        matchId: match.id,
        taskId: match.taskId,
        modelId: response.modelId,
        latencyMs: response.latencyMs,
        error: response.error ?? 'unknown',
      });
      return;
    }
    const flags = detectResponseAnomalies(response);
    if (flags.length > 0) {
      this.logger.warn('competitor.suspicious', {
        matchId: match.id,
        taskId: match.taskId,
        modelId: response.modelId,
        flags,
        latencyMs: response.latencyMs,
        outputTokens: response.outputTokens,
        reasoningTokens: response.reasoningTokens ?? null,
        costUsd: response.costUsd,
        finishReason: response.finishReason,
      });
    }
  }

  private async runCompetitor(
    match: ScheduledMatch,
    side: 'A' | 'B',
    prompt: { system: string; user: string },
    signal?: AbortSignal,
  ): Promise<CompetitorResponse> {
    const modelId = side === 'A' ? match.modelA : match.modelB;
    const startedAt = Date.now();
    let sequence = 0;
    const emitDelta = (text: string, done: boolean, success = true): void => {
      sequence += 1;
      this.emit({
        id: `${match.id}-delta-${side}-${sequence}`,
        type: 'competitor.delta',
        data: { matchId: match.id, modelId, side, text, done, success },
      });
    };
    try {
      throwIfCancelled(signal);
      const completion = await this.gateway.complete({
        model: getModel(modelId),
        ...prompt,
        signal,
        onDelta: (text) => emitDelta(text, false),
      });
      throwIfCancelled(signal);
      emitDelta(completion.content, true);
      return { modelId, success: true, ...completion };
    } catch (error) {
      if (signal?.aborted || isArenaCancellationError(error)) {
        throw new ArenaCancellationError();
      }
      const failed = failedResponse(modelId, error, Date.now() - startedAt);
      emitDelta(failed.error, true, false);
      return failed;
    }
  }
}
