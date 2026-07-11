import { applyEloWin, ELO_INITIAL } from './elo.js';
import { JudgePanel } from './judges.js';
import { noopLogger, type ArenaLogger } from './logger.js';
import { getModel, listModels } from './models.js';
import { sanitizeError } from './openrouter.js';
import { writeReports } from './report.js';
import { scheduleMatches } from './scheduler.js';
import { ArenaStore } from './store.js';
import { buildCompetitorPrompt } from './tasks.js';
import { detectResponseAnomalies } from './triage.js';
import {
  METHODOLOGY_VERSION,
  type ArenaEvent,
  type ArenaEventSink,
  type ArenaRunConfig,
  type CompleteArenaTask,
  type CompetitorResponse,
  type MatchResult,
  type OpenRouterGateway,
  type ScheduledMatch,
} from './types.js';

/** Matches with at least one failed response at or past this rate halt the run. */
const HEALTH_STOP_MIN_MATCHES = 4;
const HEALTH_STOP_FAILURE_RATE = 0.5;

function failedResponse(modelId: string, error: unknown, latencyMs: number): CompetitorResponse {
  return {
    modelId,
    success: false,
    error: sanitizeError(error),
    generationId: '',
    content: '',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    latencyMs,
    finishReason: 'error',
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

  private emit(event: Omit<ArenaEvent, 'timestamp'>): void {
    this.onEvent?.({ ...event, timestamp: new Date().toISOString() });
  }

  async run(
    config: ArenaRunConfig,
    tasks: CompleteArenaTask[],
  ): Promise<{ runId: string; completed: number; costUsd: number; stoppedForBudget: boolean }> {
    const mismatched = tasks.filter((task) => task.public.category !== config.category);
    if (mismatched.length > 0) {
      throw new Error(`Run category ${config.category} received tasks from another arena: ${mismatched.map((t) => t.public.id).join(', ')}`);
    }
    const competitors = listModels('competitor');
    await Promise.all([...competitors, ...listModels('judge')].map((model) => this.gateway.validateModel(model)));
    const schedule = scheduleMatches({
      category: config.category,
      seed: config.seed,
      count: config.matches,
      modelIds: competitors.map((model) => model.id),
      tasks,
    });
    const runId = schedule[0]?.runId ?? 'run';
    const byTask = new Map(tasks.map((task) => [task.public.id, task]));
    const completedIds = this.store.completedMatchIds();
    const existingRunResults = this.store.readAll().filter((result) => result.runId === runId);
    let runCost = existingRunResults.reduce((sum, result) => sum + result.matchCostUsd, 0);
    let completed = 0;
    let matchesWithFailures = 0;
    let stoppedForBudget = false;

    this.logger.info('run.started', {
      runId,
      category: config.category,
      seed: config.seed,
      matches: config.matches,
      maxCostUsd: config.maxCostUsd,
      resume: config.resume,
      healthStop: config.healthStop !== false,
    });
    this.emit({
      id: `${runId}-started`,
      type: 'run.started',
      data: { runId, category: config.category, seed: config.seed, matches: config.matches, maxCostUsd: config.maxCostUsd },
    });

    for (const match of schedule) {
      if (completedIds.has(match.id)) {
        if (config.resume) continue;
        throw new Error(`Match ${match.id} is already journaled; rerun with --resume or choose a new seed`);
      }
      if (runCost >= config.maxCostUsd) {
        stoppedForBudget = true;
        this.emit({
          id: `${match.runId}-budget-stopped`,
          type: 'run.budget-stopped',
          data: { runId: match.runId, completed, costUsd: runCost, maxCostUsd: config.maxCostUsd },
        });
        break;
      }
      const task = byTask.get(match.taskId);
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
      const result = await this.runMatch(match, task);
      this.store.append(result);
      writeReports(this.store);
      runCost += result.matchCostUsd;
      completed += 1;
      if (!result.competitors.responseA.success || !result.competitors.responseB.success) {
        matchesWithFailures += 1;
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
          completed,
          total: schedule.length,
        },
      });
      console.log(
        `[${match.index + 1}/${schedule.length}] ${match.taskId}: ${result.winnerModelId ?? 'no contest'} (${result.outcome}, $${result.matchCostUsd.toFixed(4)})`,
      );
      if (
        config.healthStop !== false &&
        completed >= HEALTH_STOP_MIN_MATCHES &&
        matchesWithFailures / completed >= HEALTH_STOP_FAILURE_RATE
      ) {
        this.logger.error('run.health-stopped', {
          runId,
          completed,
          matchesWithFailures,
          failureRate: matchesWithFailures / completed,
        });
        throw new Error(
          `Run halted after ${completed} matches: ${matchesWithFailures} had failed competitor responses. ` +
            `The provider path is unhealthy, so continuing would journal junk matches. ` +
            `Inspect the run log${this.logger.filePath ? ` at ${this.logger.filePath}` : ''}, fix the cause, ` +
            `then rerun with --resume (or pass --no-health-stop to override).`,
        );
      }
    }

    writeReports(this.store);
    this.logger.info('run.completed', {
      runId,
      completed,
      matchesWithFailures,
      costUsd: runCost,
      stoppedForBudget,
    });
    this.emit({
      id: `${runId}-completed`,
      type: 'run.completed',
      data: { runId, completed, costUsd: runCost, stoppedForBudget },
    });
    return { runId, completed, costUsd: runCost, stoppedForBudget };
  }

  private async runMatch(match: ScheduledMatch, task: CompleteArenaTask): Promise<MatchResult> {
    const state = this.store.rebuildEloState();
    const prompt = buildCompetitorPrompt(task);
    const [responseA, responseB] = await Promise.all([
      this.runCompetitor(match, 'A', prompt),
      this.runCompetitor(match, 'B', prompt),
    ]);
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
          costUsd: responseA.costUsd,
          outputTokens: responseA.outputTokens,
          reasoningTokens: responseA.reasoningTokens ?? null,
        },
        modelB: {
          success: responseB.success,
          latencyMs: responseB.latencyMs,
          costUsd: responseB.costUsd,
          outputTokens: responseB.outputTokens,
          reasoningTokens: responseB.reasoningTokens ?? null,
        },
      },
    });
    const eloBefore = {
      [match.modelA]: state.ratings[match.modelA] ?? ELO_INITIAL,
      [match.modelB]: state.ratings[match.modelB] ?? ELO_INITIAL,
    };
    const eloAfter = { ...eloBefore };
    let outcome: MatchResult['outcome'] = 'no-contest';
    let winnerModelId: string | null = null;
    let panel: MatchResult['panel'] = null;

    if (responseA.success !== responseB.success) {
      outcome = 'forfeit';
      winnerModelId = responseA.success ? match.modelA : match.modelB;
    } else if (responseA.success && responseB.success) {
      this.emit({
        id: `${match.id}-judging-started`,
        type: 'judging.started',
        data: { matchId: match.id, judges: listModels('judge').map((model) => model.id) },
      });
      panel = await this.judges.judge({ match, task, responseA, responseB });
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

    const judgeCost = panel?.votes.reduce((sum, vote) => sum + (vote.completion?.costUsd ?? 0), 0) ?? 0;
    return {
      methodologyVersion: METHODOLOGY_VERSION,
      runId: match.runId,
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
      eloBefore,
      eloAfter,
      pointAwarded: winnerModelId !== null,
      matchCostUsd: responseA.costUsd + responseB.costUsd + judgeCost,
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
      const completion = await this.gateway.complete({
        model: getModel(modelId),
        ...prompt,
        onDelta: (text) => emitDelta(text, false),
      });
      emitDelta(completion.content, true);
      return { modelId, success: true, ...completion };
    } catch (error) {
      const failed = failedResponse(modelId, error, Date.now() - startedAt);
      emitDelta(failed.error ?? 'Request failed', true, false);
      return failed;
    }
  }
}
