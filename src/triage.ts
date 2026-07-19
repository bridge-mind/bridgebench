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
  outcomes: { judged: number; forfeit: number; 'no-contest': number; 'speed-decided': number };
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

function describeFlags(response: CompetitorResponse): string {
  if (!response.success) return response.error;
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
      outcomes: { judged: 0, forfeit: 0, 'no-contest': 0, 'speed-decided': 0 },
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
          model.avgLatencyMs =
            ((model.avgLatencyMs ?? 0) * (model.matches - model.failures - 1) +
              response.latencyMs) /
            (model.matches - model.failures);
          model.avgOutputTokens =
            ((model.avgOutputTokens ?? 0) * (model.matches - model.failures - 1) +
              response.outputTokens) /
            (model.matches - model.failures);
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
            detail: describeFlags(response),
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
      report.judge.avgConfidence =
        confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
    }
    reports.push(report);
  }

  return reports.sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp));
}

const HEALTH_ADVICE: Record<string, string> = {
  failed:
    'Request failed — check the run log for the attempt-level error and whether retries were exhausted.',
  'fast-response': `Response landed under ${FAST_RESPONSE_MS / 1_000}s — the task may be too easy for this model, or reasoning effort was not applied.`,
  'low-output': `Fewer than ${LOW_OUTPUT_TOKENS} output tokens — likely a shallow answer; consider hardening the task.`,
  truncated: 'finish_reason=length — raise maxTokens or shorten the prompt.',
  'reasoning-unreported':
    'Provider reported no reasoning tokens — verify the reasoning parameter reaches the model (arena generation <id>).',
  'zero-cost': 'Zero cost on a successful response — usage accounting may be broken.',
  'zero-cost-match': 'A judged match with $0 spend means usage accounting is broken end to end.',
  'judge-abstained':
    'A judge returned no valid structured verdict twice — inspect judge.verdict-parse-failed entries in the run log.',
};

/**
 * Position-bias monitoring. Seats are permuted per judge, so a neutral judge
 * should pick its anonymous seat A ~50% of the time and should pick the same
 * competitor at the same rate regardless of which seat it lands in. The
 * production audit of Jul 2026 measured per-judge seat swings up to 17 points,
 * so any |swing| or seat-A deviation past this threshold over a full window is
 * flagged for calibration review.
 */
export const SEAT_SWING_ALERT_THRESHOLD = 0.08;
export const SEAT_SWING_MIN_VOTES = 50;
/** A per-competitor swing is only meaningful with a few votes in each seat. */
export const SEAT_SWING_MIN_SEAT_VOTES = 10;

export interface JudgeSeatSwing {
  competitorId: string;
  seatAVotes: number;
  seatBVotes: number;
  /** Fraction of this judge's votes, with the competitor in seat A, that picked it. */
  pickRateSeatA: number;
  /** Fraction of this judge's votes, with the competitor in seat B, that picked it. */
  pickRateSeatB: number;
  /** pickRateSeatA - pickRateSeatB; positive means the judge rewards seat A. */
  swing: number;
}

export interface JudgeSeatBias {
  judgeModelId: string;
  votes: number;
  /** Fraction of valid votes where the judge picked its (permuted) seat A. */
  seatAPickRate: number;
  swings: JudgeSeatSwing[];
  maxAbsSwing: number | null;
  alert: boolean;
}

/**
 * Journal-wide (not per-run) seat-bias report: swings need volume, so this
 * pools every valid vote passed in and only alerts past SEAT_SWING_MIN_VOTES.
 */
export function analyzeJudgeSeatBias(results: MatchResult[]): JudgeSeatBias[] {
  interface SeatTally {
    votes: number;
    pickedSeatA: number;
    byCompetitor: Map<string, { aVotes: number; aPicks: number; bVotes: number; bPicks: number }>;
  }
  const byJudge = new Map<string, SeatTally>();

  for (const result of results) {
    if (!result.panel) continue;
    for (const vote of result.panel.votes) {
      if (!vote.winnerModelId) continue;
      const tally = byJudge.get(vote.judgeModelId) ?? {
        votes: 0,
        pickedSeatA: 0,
        byCompetitor: new Map(),
      };
      tally.votes += 1;
      if (vote.winnerModelId === vote.modelAIdentity) tally.pickedSeatA += 1;
      for (const [competitorId, seat] of [
        [vote.modelAIdentity, 'a'],
        [vote.modelBIdentity, 'b'],
      ] as const) {
        const entry = tally.byCompetitor.get(competitorId) ?? {
          aVotes: 0,
          aPicks: 0,
          bVotes: 0,
          bPicks: 0,
        };
        if (seat === 'a') {
          entry.aVotes += 1;
          if (vote.winnerModelId === competitorId) entry.aPicks += 1;
        } else {
          entry.bVotes += 1;
          if (vote.winnerModelId === competitorId) entry.bPicks += 1;
        }
        tally.byCompetitor.set(competitorId, entry);
      }
      byJudge.set(vote.judgeModelId, tally);
    }
  }

  const reports: JudgeSeatBias[] = [];
  for (const [judgeModelId, tally] of byJudge) {
    const swings: JudgeSeatSwing[] = [];
    for (const [competitorId, entry] of tally.byCompetitor) {
      if (entry.aVotes < SEAT_SWING_MIN_SEAT_VOTES || entry.bVotes < SEAT_SWING_MIN_SEAT_VOTES) {
        continue;
      }
      const pickRateSeatA = entry.aPicks / entry.aVotes;
      const pickRateSeatB = entry.bPicks / entry.bVotes;
      swings.push({
        competitorId,
        seatAVotes: entry.aVotes,
        seatBVotes: entry.bVotes,
        pickRateSeatA,
        pickRateSeatB,
        swing: pickRateSeatA - pickRateSeatB,
      });
    }
    swings.sort((left, right) => Math.abs(right.swing) - Math.abs(left.swing));
    const seatAPickRate = tally.pickedSeatA / tally.votes;
    const maxAbsSwing = swings.length > 0 ? Math.abs(swings[0]!.swing) : null;
    const alert =
      tally.votes >= SEAT_SWING_MIN_VOTES &&
      (Math.abs(seatAPickRate - 0.5) >= SEAT_SWING_ALERT_THRESHOLD ||
        (maxAbsSwing !== null && maxAbsSwing >= SEAT_SWING_ALERT_THRESHOLD));
    reports.push({ judgeModelId, votes: tally.votes, seatAPickRate, swings, maxAbsSwing, alert });
  }

  return reports.sort((left, right) => left.judgeModelId.localeCompare(right.judgeModelId));
}

/**
 * Per-judge confidence calibration. Each decisive vote is a probabilistic
 * prediction — "my pick wins the match" at the stated confidence — scored
 * against the final match outcome with the Brier rule: (confidence - won)².
 * 0 is perfect, 0.25 is what always answering 0.5 scores, and anything above
 * 0.25 means the judge's confidence is anti-informative. TIE/ABSTAIN votes
 * carry no directional prediction and are excluded, as are matches that ended
 * without a winner (nothing to score against).
 */
export const BRIER_ALERT_THRESHOLD = 0.25;
export const BRIER_MIN_VOTES = 20;

export interface JudgeCalibration {
  judgeModelId: string;
  /** Decisive votes on matches that produced a final winner. */
  scoredVotes: number;
  /** Fraction of scored votes that agreed with the final match winner. */
  agreementRate: number;
  avgConfidence: number;
  /** Mean Brier score across scored votes; lower is better calibrated. */
  brierScore: number;
  /** Brier of always predicting this judge's own agreement rate (skill baseline). */
  referenceBrier: number;
  alert: boolean;
}

export function analyzeJudgeCalibration(results: MatchResult[]): JudgeCalibration[] {
  interface Tally {
    scoredVotes: number;
    agreements: number;
    confidenceSum: number;
    brierSum: number;
  }
  const byJudge = new Map<string, Tally>();

  for (const result of results) {
    if (!result.panel || !result.winnerModelId) continue;
    for (const vote of result.panel.votes) {
      if (!vote.verdict || !vote.winnerModelId) continue;
      const confidence = vote.verdict.confidence;
      const won = vote.winnerModelId === result.winnerModelId ? 1 : 0;
      const tally = byJudge.get(vote.judgeModelId) ?? {
        scoredVotes: 0,
        agreements: 0,
        confidenceSum: 0,
        brierSum: 0,
      };
      tally.scoredVotes += 1;
      tally.agreements += won;
      tally.confidenceSum += confidence;
      tally.brierSum += (confidence - won) ** 2;
      byJudge.set(vote.judgeModelId, tally);
    }
  }

  const reports: JudgeCalibration[] = [];
  for (const [judgeModelId, tally] of byJudge) {
    const agreementRate = tally.agreements / tally.scoredVotes;
    const brierScore = tally.brierSum / tally.scoredVotes;
    // Brier of the constant forecast at the judge's own base rate: p(1-p).
    const referenceBrier = agreementRate * (1 - agreementRate);
    reports.push({
      judgeModelId,
      scoredVotes: tally.scoredVotes,
      agreementRate,
      avgConfidence: tally.confidenceSum / tally.scoredVotes,
      brierScore,
      referenceBrier,
      alert: tally.scoredVotes >= BRIER_MIN_VOTES && brierScore >= BRIER_ALERT_THRESHOLD,
    });
  }

  return reports.sort((left, right) => left.judgeModelId.localeCompare(right.judgeModelId));
}

/**
 * No-contest selection-bias monitoring. A failed response voids the match, so
 * a model that fails often is *sampled out* of its hardest matchups instead of
 * losing them — its ladder position reflects only the matches it survived.
 * This report surfaces per-model failure/void rates so a reliability skew is
 * visible next to the standings it distorts.
 */
export const NO_CONTEST_ALERT_THRESHOLD = 0.15;
export const NO_CONTEST_MIN_MATCHES = 10;

export interface ModelNoContestBias {
  modelId: string;
  matches: number;
  /** Matches where this model's own response failed the liveness gate. */
  ownFailures: number;
  ownFailureRate: number;
  /** Matches voided (no-contest) in which this model was scheduled. */
  voidedMatches: number;
  voidedRate: number;
  alert: boolean;
}

export function analyzeNoContestBias(results: MatchResult[]): ModelNoContestBias[] {
  interface Tally {
    matches: number;
    ownFailures: number;
    voidedMatches: number;
  }
  const byModel = new Map<string, Tally>();

  for (const result of results) {
    const voided = result.outcome === 'no-contest';
    for (const response of [result.competitors.responseA, result.competitors.responseB]) {
      const tally = byModel.get(response.modelId) ?? {
        matches: 0,
        ownFailures: 0,
        voidedMatches: 0,
      };
      tally.matches += 1;
      if (!response.success) tally.ownFailures += 1;
      if (voided) tally.voidedMatches += 1;
      byModel.set(response.modelId, tally);
    }
  }

  const reports: ModelNoContestBias[] = [];
  for (const [modelId, tally] of byModel) {
    const ownFailureRate = tally.ownFailures / tally.matches;
    reports.push({
      modelId,
      matches: tally.matches,
      ownFailures: tally.ownFailures,
      ownFailureRate,
      voidedMatches: tally.voidedMatches,
      voidedRate: tally.voidedMatches / tally.matches,
      alert:
        tally.matches >= NO_CONTEST_MIN_MATCHES && ownFailureRate >= NO_CONTEST_ALERT_THRESHOLD,
    });
  }

  return reports.sort(
    (left, right) =>
      right.ownFailureRate - left.ownFailureRate || left.modelId.localeCompare(right.modelId),
  );
}

export function formatNoContestBias(reports: ModelNoContestBias[]): string {
  const affected = reports.filter((report) => report.voidedMatches > 0 || report.ownFailures > 0);
  if (affected.length === 0) return '';
  const lines: string[] = ['=== No-contest selection bias (journal-wide) ==='];
  for (const report of affected) {
    const flag = report.alert ? '  ⚠ ALERT' : '';
    lines.push(
      `  ${report.modelId.padEnd(30)} ${report.matches} matches, own failures ${report.ownFailures} (${asPct(report.ownFailureRate)}), voided ${report.voidedMatches} (${asPct(report.voidedRate)})${flag}`,
    );
    if (report.matches < NO_CONTEST_MIN_MATCHES) {
      lines.push(
        `    (${report.matches}/${NO_CONTEST_MIN_MATCHES} matches — below alert window, informational only)`,
      );
    }
  }
  lines.push(
    '  A high own-failure rate removes a model from its hardest matchups without an Elo penalty — its standing covers only the matches it survived.',
  );
  return lines.join('\n');
}

export function formatJudgeCalibration(reports: JudgeCalibration[]): string {
  if (reports.length === 0) return '';
  const lines: string[] = ['=== Judge confidence calibration (journal-wide, Brier) ==='];
  for (const report of reports) {
    const flag = report.alert ? '  ⚠ ALERT' : '';
    lines.push(
      `  ${report.judgeModelId.padEnd(30)} ${report.scoredVotes} scored votes, agreement ${asPct(report.agreementRate)}, avg confidence ${report.avgConfidence.toFixed(2)}, Brier ${report.brierScore.toFixed(3)} (base-rate ref ${report.referenceBrier.toFixed(3)})${flag}`,
    );
    if (report.scoredVotes < BRIER_MIN_VOTES) {
      lines.push(
        `    (${report.scoredVotes}/${BRIER_MIN_VOTES} votes — below alert window, informational only)`,
      );
    }
  }
  return lines.join('\n');
}

const asPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

export function formatSeatBias(reports: JudgeSeatBias[]): string {
  if (reports.length === 0) return '';
  const lines: string[] = ['=== Judge seat bias (journal-wide) ==='];
  for (const report of reports) {
    const flag = report.alert ? '  ⚠ ALERT' : '';
    lines.push(
      `  ${report.judgeModelId.padEnd(30)} ${report.votes} votes, seat-A pick rate ${asPct(report.seatAPickRate)}${flag}`,
    );
    for (const swing of report.swings.slice(0, 4)) {
      lines.push(
        `    ${swing.competitorId.padEnd(28)} picked ${asPct(swing.pickRateSeatA)} in seat A (${swing.seatAVotes}v) vs ${asPct(swing.pickRateSeatB)} in seat B (${swing.seatBVotes}v) — swing ${swing.swing >= 0 ? '+' : ''}${(swing.swing * 100).toFixed(1)} pts`,
      );
    }
    if (report.votes < SEAT_SWING_MIN_VOTES) {
      lines.push(
        `    (${report.votes}/${SEAT_SWING_MIN_VOTES} votes — below alert window, informational only)`,
      );
    }
  }
  return lines.join('\n');
}

export function formatTriage(reports: RunTriage[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(`run ${report.runId} (seed "${report.seed}", ${report.firstTimestamp})`);
    lines.push(
      `  matches ${report.matches} | judged ${report.outcomes.judged}, speed-decided ${report.outcomes['speed-decided']}, forfeit ${report.outcomes.forfeit}, no-contest ${report.outcomes['no-contest']} | spend $${report.totalCostUsd.toFixed(4)}`,
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
        (report.judge.avgConfidence === null
          ? ''
          : `, avg confidence ${report.judge.avgConfidence.toFixed(2)}`),
    );
    for (const [modelId, model] of Object.entries(report.models)) {
      const latency = model.avgLatencyMs === null ? '—' : `${Math.round(model.avgLatencyMs)}ms`;
      const tokens =
        model.avgOutputTokens === null ? '—' : `${Math.round(model.avgOutputTokens)} tok`;
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
          lines.push(
            `      [${anomaly.scheduleIndex}] ${anomaly.taskId} ${anomaly.modelId ?? ''}: ${anomaly.detail.slice(0, 140)}`,
          );
        }
        if (anomalies.length > 4) lines.push(`      … ${anomalies.length - 4} more`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
