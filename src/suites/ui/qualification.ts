/**
 * Arena qualification — the harness NEVER grades quality. Models are graded
 * by builders through blind A/B community voting (Elo) on bridgebench.ai.
 *
 * What the harness does decide, objectively, is whether an artifact is
 * eligible for the arena at all. Live `ui run` generation qualifies on the
 * static contract only (self-contained, pinned vendor, harness globals in the
 * source). The explicit `ui evaluate` command can additionally supply a
 * browser evaluation, in which case its runtime gates are also enforced.
 *
 * Everything else the evaluator measures (WebGL context, FPS, animation,
 * control coverage, determinism replay, hidden probes) is recorded as
 * DIAGNOSTICS — informational badges beside the artifact, never a score.
 */

import type {
  UiArtifactEvaluationResult,
  UiArtifactValidationResult,
  UiBenchFullTask,
  UiDiagnostics,
  UiQualification,
} from './types.js';

/** Load + settle window; page errors inside it are startup crashes. */
const STARTUP_WINDOW_MS = 23_000;

export interface UiQualificationInput {
  task: UiBenchFullTask;
  validation: UiArtifactValidationResult;
  evaluation: UiArtifactEvaluationResult | null;
}

export function assessQualification(input: UiQualificationInput): UiQualification {
  const { task, validation, evaluation } = input;
  const reasons: string[] = [];

  if (!validation.valid) {
    reasons.push(...validation.errors.map((e) => `validation: ${e}`));
  }

  if (evaluation) {
    if (!evaluation.ok) {
      reasons.push(`evaluation: ${evaluation.error ?? 'failed'}`);
    }
    if (evaluation.harnessGlobalsMs === null) {
      reasons.push('contract: BridgeBench harness globals never appeared');
    }

    const startupErrors = evaluation.pageErrors.filter((message) => {
      const match = message.match(/^\[(\d+)ms\]/);
      return match ? Number(match[1]) <= STARTUP_WINDOW_MS : true;
    });
    if (startupErrors.length > 0) {
      reasons.push(`runtime: uncaught error during startup (${startupErrors[0]})`);
    }

    if (evaluation.blankFrame) {
      reasons.push('render: blank first frame');
    }
    if (evaluation.networkRequestsBlocked > 0) {
      reasons.push(`network: ${evaluation.networkRequestsBlocked} non-vendor request(s) attempted`);
    }
  }

  const controlsFound = task.controls.filter((control) =>
    evaluation
      ? evaluation.controlsFound.includes(control.id)
      : validation.metadata.declaredControlIds.includes(control.id),
  ).length;

  const probes = evaluation?.probes ?? null;

  const diagnostics: UiDiagnostics = {
    webglActive: evaluation?.webgl.active ?? null,
    webglRequirementMet: evaluation
      ? !task.requiresWebGL ||
        evaluation.webgl.active === 'webgl' ||
        evaluation.webgl.active === 'webgl2'
      : !task.requiresWebGL || validation.metadata.usesThree,
    fps: evaluation?.fps ?? null,
    animationDetected: evaluation?.animation.detected ?? false,
    controlsDeclared: task.controls.length,
    controlsFound,
    viewportFill: evaluation?.viewportFill ?? false,
    determinismOk:
      evaluation && evaluation.determinism.ran
        ? evaluation.determinism.replayChangedPct !== null &&
          evaluation.determinism.replayChangedPct <=
            (task.scoringOverrides?.determinismMaxChangedPct ?? 1.5) &&
          evaluation.determinism.statesMatch === true
        : null,
    probesPassed: probes ? probes.filter((p) => p.passed).length : null,
    probesTotal: probes ? probes.length : null,
    probesPartial: probes === null,
  };

  return {
    qualified: reasons.length === 0,
    reasons,
    diagnostics,
  };
}
