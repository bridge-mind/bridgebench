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
 * Deterministic speed winner: the competitor with the lower total wall-clock
 * completion time wins. An exact tie resolves to modelA; because modelA/modelB
 * assignment is itself randomized per match, this introduces no systematic bias.
 * The runner and the verifier both call this, so the decision is reproducible.
 */
export function speedWinner(metrics: SpeedMetrics, modelA: string, modelB: string): string {
  return metrics.a.totalMs <= metrics.b.totalMs ? modelA : modelB;
}

export interface SpeedDecision {
  outcome: 'forfeit' | 'no-contest' | 'speed-decided';
  winnerModelId: string | null;
  speedMetrics: SpeedMetrics | null;
}

/**
 * Decide a speed match from both competitor responses. Applies the liveness
 * gate first (forfeit / no-contest), then — when both competitors are live —
 * decides by lower total wall-clock time. speedMetrics is populated only for a
 * 'speed-decided' outcome; a forfeit or no-contest records none.
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
    return {
      outcome: 'speed-decided',
      winnerModelId: speedWinner(speedMetrics, modelA, modelB),
      speedMetrics,
    };
  }
  if (aLive !== bLive) {
    return { outcome: 'forfeit', winnerModelId: aLive ? modelA : modelB, speedMetrics: null };
  }
  return { outcome: 'no-contest', winnerModelId: null, speedMetrics: null };
}
