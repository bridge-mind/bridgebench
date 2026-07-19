import {
  competitorContent,
  type CompetitorResponse,
  type CompetitorSuccess,
  type SpeedMetric,
  type SpeedMetrics,
} from './types.js';

/**
 * Liveness gate for a speed competitor. This is a completion check, NOT a
 * quality judgment: a competitor is live only if it returned a successful,
 * non-empty completion. An errored, exhausted, or empty response is not live
 * and loses by forfeit. The transport already rejects empty completions, so
 * the content check is defense-in-depth against a success carrying no text.
 */
export function isLiveResponse(response: CompetitorResponse): response is CompetitorSuccess {
  return response.success && competitorContent(response).trim().length > 0;
}

/** Output tokens per second over the generation window (after the first token). */
export function outputTokensPerSecond(
  outputTokens: number,
  ttftMs: number,
  totalMs: number,
): number {
  const generationSeconds = Math.max(1e-3, (totalMs - ttftMs) / 1000);
  return outputTokens / generationSeconds;
}

/** Derive a competitor's speed metrics from its recorded completion timings. */
export function speedMetricFor(response: CompetitorSuccess): SpeedMetric {
  const ttftMs = response.ttftMs ?? 0;
  // totalMs falls back to latencyMs for completions recorded before the speed
  // arena added dedicated timing; they are the same wall-clock measurement.
  const totalMs = response.totalMs ?? response.latencyMs;
  const outputTokens = response.outputTokens;
  return {
    ttftMs,
    totalMs,
    outputTokens,
    tps: outputTokensPerSecond(outputTokens, ttftMs, totalMs),
  };
}

/**
 * How many paired trials a speed match runs per competitor. Journaled timings
 * are the median trial's, so a single provider hiccup or cache warm-up cannot
 * decide a match. (Journals before arena-v0.5.0 ran a single trial.)
 */
export const SPEED_TRIALS = 3;

/**
 * The trial whose totalMs is the median of the set — the response a speed
 * match journals. Ties inside the sort resolve by array order, so the
 * selection is deterministic for a fixed trial sequence.
 */
export function medianTrialResponse(trials: readonly CompetitorSuccess[]): CompetitorSuccess {
  if (trials.length === 0) throw new Error('medianTrialResponse requires at least one trial');
  const sorted = [...trials].sort(
    (left, right) => (left.totalMs ?? left.latencyMs) - (right.totalMs ?? right.latencyMs),
  );
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * Deterministic speed winner: the competitor with the lower total wall-clock
 * completion time wins. An exact millisecond tie returns null — the match
 * voids as no-contest rather than awarding seat A (journals before
 * arena-v0.5.0 resolved ties to modelA; their verifiers replay that rule).
 * The runner and the verifier both call this, so the decision is reproducible.
 */
export function speedWinner(metrics: SpeedMetrics, modelA: string, modelB: string): string | null {
  if (metrics.a.totalMs === metrics.b.totalMs) return null;
  return metrics.a.totalMs < metrics.b.totalMs ? modelA : modelB;
}

export interface SpeedDecision {
  outcome: 'forfeit' | 'no-contest' | 'speed-decided';
  winnerModelId: string | null;
  speedMetrics: SpeedMetrics | null;
}

/**
 * Decide a speed match from both competitor responses. Applies the liveness
 * gate first (forfeit / no-contest), then — when both competitors are live —
 * decides by lower total wall-clock time. An exact millisecond tie voids the
 * match (no winner, metrics still journaled as evidence of the tie).
 * speedMetrics is otherwise populated only for a 'speed-decided' outcome; a
 * forfeit or liveness no-contest records none.
 */
export function decideSpeedMatch(
  responseA: CompetitorResponse,
  responseB: CompetitorResponse,
  modelA: string,
  modelB: string,
): SpeedDecision {
  const aLive = isLiveResponse(responseA);
  const bLive = isLiveResponse(responseB);
  if (aLive && bLive) {
    const speedMetrics: SpeedMetrics = {
      a: speedMetricFor(responseA),
      b: speedMetricFor(responseB),
    };
    const winnerModelId = speedWinner(speedMetrics, modelA, modelB);
    return {
      outcome: winnerModelId === null ? 'no-contest' : 'speed-decided',
      winnerModelId,
      speedMetrics,
    };
  }
  // A dead side voids the match — a provider failure is not a slowness
  // signal, so nobody scores a point for the other side's outage.
  return { outcome: 'no-contest', winnerModelId: null, speedMetrics: null };
}
