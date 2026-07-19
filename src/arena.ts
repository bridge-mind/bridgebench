import { applyEloWin, ELO_INITIAL } from './elo.js';
import { JudgePanel } from './judges.js';
import { noopLogger, type ArenaLogger } from './logger.js';
import {
  ArenaCancellationError,
  isArenaCancellationError,
  throwIfCancelled,
} from './cancellation.js';
import { getJudgeModel, getModel, listModels, resolveCompetitorRoster } from './models.js';
import { sanitizeError } from './openrouter.js';
import { writeReports } from './report.js';
import { createRunManifest, runIdFromManifest, runManifestHash } from './run-manifest.js';
import { scheduleMatches } from './scheduler.js';
import { seatPanel, seatReserves } from './seating.js';
import { decideSpeedMatch, isLiveResponse, medianTrialResponse, SPEED_TRIALS } from './speed.js';
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
  stoppedForHealth: boolean;
}

interface PreparedRun {
  runId: string;
  manifestHash: string;
  competitors: ModelRegistryEntry[];
  /** The manifest's judge pool; each match seats its panel from this via seatPanel. */
  judgePoolIds: string[];
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

/**
 * The response a speed match journals for one side after its paired trials:
 * the median-total trial when every trial is live (carrying the summed cost
 * of all trials, so matchCostUsd stays the verifiable sum of journaled
 * responses), or the first dead trial when any failed — liveness voids the
 * match regardless of the other trials' timings.
 */
function journaledSpeedResponse(trials: readonly CompetitorResponse[]): CompetitorResponse {
  const dead = trials.find((trialResponse) => !isLiveResponse(trialResponse));
  if (dead) return dead;
  const live = trials.filter(isLiveResponse);
  const median = medianTrialResponse(live);
  return {
    ...median,
    costUsd: live.reduce((sum, trialResponse) => sum + trialResponse.costUsd, 0),
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
      stoppedForHealth: progress.stoppedForHealth,
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
    const judgePoolIds = manifest.judges.map((model) => model.id);
    // Pre-flight every scheduled panel so a pairing the pool cannot cover
    // fails the run here — before model validation or any paid work.
    if (config.category !== 'speed') {
      for (const match of schedule) {
        seatPanel(judgePoolIds, [match.modelA, match.modelB], match.seed, match.id);
      }
    }
    const existing = journal.filter((result) => result.runId === runId);
    const prepared: PreparedRun = {
      runId,
      manifestHash,
      competitors,
      judgePoolIds,
      schedule,
      tasksById: new Map(tasks.map((task) => [task.public.id, task])),
      completedIds: new Set(journal.map((result) => result.matchId)),
      progress: {
        costUsd: existing.reduce((sum, result) => sum + result.matchCostUsd, 0),
        completed: 0,
        matchesWithFailures: 0,
        stoppedForBudget: false,
        stoppedForHealth: false,
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
    const {
      runId,
      manifestHash,
      competitors,
      judgePoolIds,
      schedule,
      tasksById,
      completedIds,
      progress,
    } = await this.prepareRun(config, tasks, signal);
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
          result = await this.runMatch(
            match,
            task,
            manifestHash,
            competitorIds,
            judgePoolIds,
            config.ranked ?? true,
            signal,
          );
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
          // Graceful circuit breaker, mirroring the budget stop: failed
          // matches are already journaled as voided no-contests, so stop
          // scheduling new ones and end the run cleanly — completed matches
          // stand, the final journal sweep still runs, and the run records
          // as health-stopped rather than crashing to `failed`.
          progress.stoppedForHealth = true;
          this.logger.error('run.health-stopped', {
            runId,
            completed: progress.completed,
            matchesWithFailures: progress.matchesWithFailures,
            failureRate: progress.matchesWithFailures / progress.completed,
          });
          this.emit({
            id: `${runId}-health-stopped`,
            type: 'run.health-stopped',
            data: {
              runId,
              completed: progress.completed,
              matchesWithFailures: progress.matchesWithFailures,
              failureRate: progress.matchesWithFailures / progress.completed,
            },
          });
          break;
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
          stoppedForHealth: progress.stoppedForHealth,
        },
      });
      return {
        runId,
        completed: progress.completed,
        costUsd: progress.costUsd,
        stoppedForBudget: progress.stoppedForBudget,
        stoppedForHealth: progress.stoppedForHealth,
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
    judgePoolIds: readonly string[],
    ranked: boolean,
    signal?: AbortSignal,
  ): Promise<MatchResult> {
    throwIfCancelled(signal);
    const state = this.store.rebuildEloState(competitorIds);
    const prompt = buildCompetitorPrompt(task);
    let responseA: CompetitorResponse;
    let responseB: CompetitorResponse;
    if (task.public.category === 'speed') {
      // Speed matches run paired trials and journal each side's median-total
      // trial, so one provider hiccup or cache warm-up cannot decide a match.
      // The journaled response carries the whole match's cost for its side.
      const trialsA: CompetitorResponse[] = [];
      const trialsB: CompetitorResponse[] = [];
      for (let trial = 1; trial <= SPEED_TRIALS; trial += 1) {
        const [a, b] = await Promise.all([
          this.runCompetitor(match, 'A', prompt, signal, trial),
          this.runCompetitor(match, 'B', prompt, signal, trial),
        ]);
        trialsA.push(a);
        trialsB.push(b);
        // A dead side already voids the match; further trials waste budget.
        if (!isLiveResponse(a) || !isLiveResponse(b)) break;
      }
      responseA = journaledSpeedResponse(trialsA);
      responseB = journaledSpeedResponse(trialsB);
    } else {
      [responseA, responseB] = await Promise.all([
        this.runCompetitor(match, 'A', prompt, signal),
        this.runCompetitor(match, 'B', prompt, signal),
      ]);
    }
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
      // A failed response (provider outage, timeout, empty completion) voids
      // the match: no winner, no point, no Elo movement. Scoring an
      // infrastructure failure as a loss punished models for their
      // provider's downtime — the surviving answer is never judged either,
      // so there is no quality signal to award.
      outcome = 'no-contest';
    } else if (responseA.success && responseB.success) {
      if (!isCompleteArenaTask(task)) {
        throw new Error(
          `A judged ${task.public.category} match requires a task with its hidden reference`,
        );
      }
      // The seated panel is deterministic in (pool, competitors, seed,
      // matchId) — verification re-derives it; the event carries it for UIs.
      const seatedJudgeIds = seatPanel(
        judgePoolIds,
        [match.modelA, match.modelB],
        match.seed,
        match.id,
      );
      // Adjudication reserves (ranks 4..5 of the same ordering) sit only when
      // the primary panel splits, tie-majorities, or loses a vote to
      // abstention. An empty reserve list just disables escalation.
      const reserveJudgeIds = seatReserves(
        judgePoolIds,
        [match.modelA, match.modelB],
        match.seed,
        match.id,
      );
      this.emit({
        id: `${match.id}-judging-started`,
        type: 'judging.started',
        data: { matchId: match.id, judges: seatedJudgeIds },
      });
      panel = await this.judges.judge(
        {
          match,
          task,
          responseA,
          responseB,
          judges: seatedJudgeIds.map(getJudgeModel),
          reserveJudges: reserveJudgeIds.map(getJudgeModel),
        },
        signal,
      );
      throwIfCancelled(signal);
      if (panel.winnerModelId) {
        outcome = 'judged';
        winnerModelId = panel.winnerModelId;
      }
    }

    // Exhibition matches keep the verdict but never move the ladder:
    // eloAfter stays equal to eloBefore, and verification enforces that.
    if (winnerModelId && ranked) {
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
      ranked,
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
    trial = 1,
  ): Promise<CompetitorResponse> {
    const modelId = side === 'A' ? match.modelA : match.modelB;
    const startedAt = Date.now();
    let sequence = 0;
    // Trial 1 keeps the historical event-id shape; extra speed trials get a
    // distinct prefix so their deltas never collide with trial 1's ids.
    const idPrefix =
      trial === 1 ? `${match.id}-delta-${side}` : `${match.id}-t${trial}-delta-${side}`;
    const emitDelta = (text: string, done: boolean, success = true): void => {
      sequence += 1;
      this.emit({
        id: `${idPrefix}-${sequence}`,
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
