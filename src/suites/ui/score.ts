/**
 * Harness scoring — five dimensions, weights in SCORING_WEIGHTS
 * (renderIntegrity 25 / motion 15 / interaction 30 / determinism 15 /
 * specAdherence 15). The harness score is frozen at run time; community
 * Elo is a separate axis and is NEVER folded into these numbers.
 *
 * Hard-fail gates (score 0 across the board):
 *   - static validation errors
 *   - harness globals never appeared
 *   - page error during initial load (before the settle window ended)
 *   - blank first frame
 *   - any non-vendor network attempt
 */

import { DEFAULT_MOTION_MIN_CHANGED_PCT } from './evaluator/index.js';
import {
  SCORING_WEIGHTS,
  type UiArtifactEvaluationResult,
  type UiArtifactValidationResult,
  type UiBenchFullTask,
  type UiScoreBreakdown,
} from './types.js';

const DEFAULT_DETERMINISM_MAX_CHANGED_PCT = 1.5;
/** Load + settle window; page errors inside it are startup crashes. */
const STARTUP_WINDOW_MS = 23_000;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

export interface UiScoreInput {
  task: UiBenchFullTask;
  validation: UiArtifactValidationResult;
  evaluation: UiArtifactEvaluationResult | null;
}

export function calculateUiScore(input: UiScoreInput): UiScoreBreakdown {
  const { task, validation, evaluation } = input;

  const zero: UiScoreBreakdown = {
    renderIntegrity: 0,
    motion: 0,
    interaction: 0,
    determinism: 0,
    specAdherence: 0,
    total: 0,
    interactionPartial: evaluation?.probes == null,
  };

  if (!validation.valid || !evaluation || !evaluation.ok) return zero;

  const startupPageErrors = evaluation.pageErrors.filter((message) => {
    const match = message.match(/^\[(\d+)ms\]/);
    return match ? Number(match[1]) <= STARTUP_WINDOW_MS : true;
  });

  const hardFail =
    evaluation.harnessGlobalsMs === null ||
    startupPageErrors.length > 0 ||
    evaluation.blankFrame ||
    evaluation.networkRequestsBlocked > 0;

  if (hardFail) return zero;

  // ── Render integrity (25) ────────────────────────────────────────────
  let renderIntegrity = 100;
  const latePageErrors = evaluation.pageErrors.length - startupPageErrors.length;
  renderIntegrity -= Math.min(75, latePageErrors * 25);
  renderIntegrity -= Math.min(25, evaluation.consoleErrorCount * 5);
  if (evaluation.startupTimeMs > 10_000) renderIntegrity -= 20;
  if (task.requiresWebGL && evaluation.webgl.active !== 'webgl' && evaluation.webgl.active !== 'webgl2') {
    renderIntegrity -= 40;
  }
  renderIntegrity = clamp(renderIntegrity);

  // ── Motion & liveness (15): animation 12/15, FPS floor 3/15 ─────────
  const motionThreshold =
    task.scoringOverrides?.motionMinChangedPct ?? DEFAULT_MOTION_MIN_CHANGED_PCT;
  const animated = evaluation.animation.changedPct.some((pct) => pct >= motionThreshold);
  const fps = evaluation.fps ?? 0;
  const fpsScore = fps >= 10 ? 100 : fps >= 5 ? 50 : 0;
  const motion = clamp((animated ? 100 : 0) * (12 / 15) + fpsScore * (3 / 15));

  // ── Interaction (30) ────────────────────────────────────────────────
  let interaction: number;
  let interactionPartial: boolean;
  if (evaluation.probes && evaluation.probes.length > 0) {
    const totalWeight = evaluation.probes.reduce((sum, p) => sum + p.weight, 0);
    const passedWeight = evaluation.probes
      .filter((p) => p.passed)
      .reduce((sum, p) => sum + p.weight, 0);
    interaction = clamp((passedWeight / totalWeight) * 100);
    interactionPartial = false;
  } else {
    // Public run without the private overlay: fall back to declared-control
    // presence so open-source users still get a signal — flagged partial.
    const declared = task.controls.length;
    const found = task.controls.filter((c) =>
      evaluation.controlsFound.includes(c.id),
    ).length;
    interaction = declared === 0 ? 100 : clamp((found / declared) * 100);
    interactionPartial = true;
  }

  // ── Determinism & contract (15): manifest 5, replay 7, state 3 ─────
  const manifestScore = evaluation.harnessGlobalsMs !== null ? 100 : 0;
  const tolerance =
    task.scoringOverrides?.determinismMaxChangedPct ?? DEFAULT_DETERMINISM_MAX_CHANGED_PCT;
  let replayScore = 0;
  if (evaluation.determinism.ran && evaluation.determinism.replayChangedPct !== null) {
    const pct = evaluation.determinism.replayChangedPct;
    replayScore = pct <= tolerance ? 100 : pct <= tolerance * 2 ? 50 : 0;
  }
  const stateScore = evaluation.determinism.statesMatch === true ? 100 : 0;
  const determinism = clamp(
    manifestScore * (5 / 15) + replayScore * (7 / 15) + stateScore * (3 / 15),
  );

  // ── Spec adherence (15): controls 8, viewport 3, statics 4 ─────────
  const declared = task.controls.length;
  const found = task.controls.filter((c) => evaluation.controlsFound.includes(c.id)).length;
  const controlsScore = declared === 0 ? 100 : (found / declared) * 100;
  const viewportScore = evaluation.viewportFill ? 100 : 0;
  const expectedShots = task.screenshots.map((s) => s.name);
  const shotsTaken = expectedShots.filter((name) => evaluation.screenshots[name]).length;
  const staticsScore =
    (shotsTaken / Math.max(1, expectedShots.length)) * 50 +
    (evaluation.getScoreOk ? 25 : 0) +
    (evaluation.destroyOk ? 25 : 0);
  const specAdherence = clamp(
    controlsScore * (8 / 15) + viewportScore * (3 / 15) + staticsScore * (4 / 15),
  );

  const dims = { renderIntegrity, motion, interaction, determinism, specAdherence };
  const total =
    Object.entries(SCORING_WEIGHTS).reduce(
      (sum, [dim, weight]) => sum + dims[dim as keyof typeof dims] * weight,
      0,
    ) / 100;

  return {
    renderIntegrity: round1(renderIntegrity),
    motion: round1(motion),
    interaction: round1(interaction),
    determinism: round1(determinism),
    specAdherence: round1(specAdherence),
    total: round1(total),
    interactionPartial,
  };
}
