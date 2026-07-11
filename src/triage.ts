import type { CompetitorResponse, MatchResult } from './types.js';

/**
 * A judged reasoning match at high effort that returns this fast almost always
 * means the task was too easy, the reasoning parameter was dropped, or the
 * request failed silently. Flag it either way — a human decides.
 */
export const FAST_RESPONSE_MS = 5_000;
export const LOW_OUTPUT_TOKENS = 150;

export interface TriageAnomaly {
  matchId: string;
  scheduleIndex: number;
  taskId: string;
  modelId: string | null;
  flag: string;
  detail: string;
}

export interface ModelTriage {
  matches: number;
  failures: number;
  wins: number;
  avgLatencyMs: number | null;
  avgOutputTokens: number | null;
  reasoningReported: number;
}

export interface RunTriage {
  runId: string;
  seed: string;
  firstTimestamp: string;
  matches: number;
  outcomes: { judged: number; forfeit: number; 'no-contest': number };
  totalCostUsd: number;
  errorClasses: Record<string, number>;
  models: Record<string, ModelTriage>;
  judge: {
    validVotes: number;
    abstentions: number;
    unanimous: number;
    split: number;
    avgConfidence: number | null;
  };
  anomalies: TriageAnomaly[];
}

export function classifyError(message: string): string {
  if (/premature close|invalid response body/i.test(message)) return 'premature-close';
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) return 'timeout';
  if (/429|rate.?limit/i.test(message)) return 'rate-limit';
  if (/5\d\d|overloaded/i.test(message)) return 'server-error';
  if (/401|403|unauthorized|forbidden/i.test(message)) return 'auth';
  if (/empty completion/i.test(message)) return 'empty-completion';
  return 'other';
}

/** Flags that make a single competitor response worth a second look. */
export function detectResponseAnomalies(response: CompetitorResponse): string[] {
  if (!response.success) return ['failed'];
  const flags: string[] = [];
  if (response.latencyMs < FAST_RESPONSE_MS) flags.push('fast-response');
  if (response.outputTokens < LOW_OUTPUT_TOKENS) flags.push('low-output');
  if (response.finishReason === 'length') flags.push('truncated');
  if (!response.reasoningTokens) flags.push('reasoning-unreported');
  if (response.costUsd === 0) flags.push('zero-cost');
  return flags;
}

function describeFlags(response: CompetitorResponse, flags: string[]): string {
  if (flags[0] === 'failed') return response.error ?? 'request failed';
  return `${response.latencyMs}ms, ${response.outputTokens} output tokens, reasoning ${
    response.reasoningTokens ?? 'unreported'
  }, finish ${response.finishReason}, $${response.costUsd.toFixed(4)}`;
}

export function triageJournal(results: MatchResult[]): RunTriage[] {
  const byRun = new Map<string, MatchResult[]>();
  for (const result of results) {
    const bucket = byRun.get(result.runId) ?? [];
    bucket.push(result);
    byRun.set(result.runId, bucket);
  }

  const reports: RunTriage[] = [];
  for (const [runId, runResults] of byRun) {
    const report: RunTriage = {
      runId,
      seed: runResults[0]!.seed,
      firstTimestamp: runResults[0]!.timestamp,
      matches: runResults.length,
      outcomes: { judged: 0, forfeit: 0, 'no-contest': 0 },
      totalCostUsd: 0,
      errorClasses: {},
      models: {},
      judge: { validVotes: 0, abstentions: 0, unanimous: 0, split: 0, avgConfidence: null },
      anomalies: [],
    };
    const confidences: number[] = [];

    for (const result of runResults) {
      report.outcomes[result.outcome] += 1;
      report.totalCostUsd += result.matchCostUsd;
      for (const response of [result.competitors.responseA, result.competitors.responseB]) {
        const model = (report.models[response.modelId] ??= {
          matches: 0,
          failures: 0,
          wins: 0,
          avgLatencyMs: null,
          avgOutputTokens: null,
          reasoningReported: 0,
        });
        model.matches += 1;
        if (!response.success) {
          model.failures += 1;
          const errorClass = classifyError(response.error ?? '');
          report.errorClasses[errorClass] = (report.errorClasses[errorClass] ?? 0) + 1;
        } else {
          model.avgLatencyMs = ((model.avgLatencyMs ?? 0) * (model.matches - model.failures - 1) + response.latencyMs) / (model.matches - model.failures);
          model.avgOutputTokens = ((model.avgOutputTokens ?? 0) * (model.matches - model.failures - 1) + response.outputTokens) / (model.matches - model.failures);
          if (response.reasoningTokens) model.reasoningReported += 1;
        }
        const flags = detectResponseAnomalies(response);
        for (const flag of flags) {
          report.anomalies.push({
            matchId: result.matchId,
            scheduleIndex: result.scheduleIndex,
            taskId: result.task.id,
            modelId: response.modelId,
            flag,
            detail: describeFlags(response, flags),
          });
        }
      }
      if (result.winnerModelId && report.models[result.winnerModelId]) {
        report.models[result.winnerModelId]!.wins += 1;
      }
      if (result.panel) {
        if (result.panel.agreement === 'unanimous') report.judge.unanimous += 1;
        if (result.panel.agreement === 'split') report.judge.split += 1;
        for (const vote of result.panel.votes) {
          if (vote.verdict) {
            report.judge.validVotes += 1;
            confidences.push(vote.verdict.confidence);
          } else {
            report.judge.abstentions += 1;
            report.anomalies.push({
              matchId: result.matchId,
              scheduleIndex: result.scheduleIndex,
              taskId: result.task.id,
              modelId: vote.judgeModelId,
              flag: 'judge-abstained',
              detail: vote.error ?? 'no valid verdict',
            });
          }
        }
      }
      if (result.outcome === 'judged' && result.matchCostUsd === 0) {
        report.anomalies.push({
          matchId: result.matchId,
          scheduleIndex: result.scheduleIndex,
          taskId: result.task.id,
          modelId: null,
          flag: 'zero-cost-match',
          detail: 'judged match reported $0 total cost',
        });
      }
    }

    if (confidences.length > 0) {
      report.judge.avgConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    }
    reports.push(report);
  }

  return reports.sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp));
}

const HEALTH_ADVICE: Record<string, string> = {
  failed: 'Request failed — check the run log for the attempt-level error and whether retries were exhausted.',
  'fast-response': `Response landed under ${FAST_RESPONSE_MS / 1_000}s — the task may be too easy for this model, or reasoning effort was not applied.`,
  'low-output': `Fewer than ${LOW_OUTPUT_TOKENS} output tokens — likely a shallow answer; consider hardening the task.`,
  truncated: 'finish_reason=length — raise maxTokens or shorten the prompt.',
  'reasoning-unreported': 'Provider reported no reasoning tokens — verify the reasoning parameter reaches the model (arena generation <id>).',
  'zero-cost': 'Zero cost on a successful response — usage accounting may be broken.',
  'zero-cost-match': 'A judged match with $0 spend means usage accounting is broken end to end.',
  'judge-abstained': 'A judge returned no valid structured verdict twice — inspect judge.verdict-parse-failed entries in the run log.',
};

export function formatTriage(reports: RunTriage[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`run ${report.runId} (seed "${report.seed}", ${report.firstTimestamp})`);
    lines.push(
      `  matches ${report.matches} | judged ${report.outcomes.judged}, forfeit ${report.outcomes.forfeit}, no-contest ${report.outcomes['no-contest']} | spend $${report.totalCostUsd.toFixed(4)}`,
    );
    if (Object.keys(report.errorClasses).length > 0) {
      lines.push(
        `  request failures: ${Object.entries(report.errorClasses)
          .map(([errorClass, count]) => `${errorClass}×${count}`)
          .join(', ')}`,
      );
    }
    lines.push(
      `  judges: ${report.judge.validVotes} valid votes, ${report.judge.abstentions} abstentions, ${report.judge.unanimous} unanimous / ${report.judge.split} split panels` +
        (report.judge.avgConfidence === null ? '' : `, avg confidence ${report.judge.avgConfidence.toFixed(2)}`),
    );
    for (const [modelId, model] of Object.entries(report.models)) {
      const latency = model.avgLatencyMs === null ? '—' : `${Math.round(model.avgLatencyMs)}ms`;
      const tokens = model.avgOutputTokens === null ? '—' : `${Math.round(model.avgOutputTokens)} tok`;
      lines.push(
        `    ${modelId.padEnd(30)} matches ${model.matches}, wins ${model.wins}, failures ${model.failures}, avg ${latency} / ${tokens}, reasoning reported ${model.reasoningReported}/${model.matches - model.failures}`,
      );
    }
    if (report.anomalies.length === 0) {
      lines.push('  no anomalies detected');
    } else {
      lines.push(`  anomalies (${report.anomalies.length}):`);
      const byFlag = new Map<string, TriageAnomaly[]>();
      for (const anomaly of report.anomalies) {
        const bucket = byFlag.get(anomaly.flag) ?? [];
        bucket.push(anomaly);
        byFlag.set(anomaly.flag, bucket);
      }
      for (const [flag, anomalies] of byFlag) {
        lines.push(`    ${flag} ×${anomalies.length} — ${HEALTH_ADVICE[flag] ?? ''}`);
        for (const anomaly of anomalies.slice(0, 4)) {
          lines.push(`      [${anomaly.scheduleIndex}] ${anomaly.taskId} ${anomaly.modelId ?? ''}: ${anomaly.detail.slice(0, 140)}`);
        }
        if (anomalies.length > 4) lines.push(`      … ${anomalies.length - 4} more`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
