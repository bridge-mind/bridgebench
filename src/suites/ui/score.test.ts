import { describe, expect, it } from 'vitest';

import { calculateUiScore } from './score.js';
import type {
  UiArtifactEvaluationResult,
  UiArtifactValidationResult,
  UiBenchFullTask,
} from './types.js';

function makeTask(overrides: Partial<UiBenchFullTask> = {}): UiBenchFullTask {
  return {
    id: 's1-lava-lamp-redux',
    season: 1,
    title: 'Lava Lamp Redux',
    category: 'simulation',
    requiresWebGL: true,
    viewport: { width: 1280, height: 800 },
    libraries: { three: '0.182.0' },
    controls: [
      { id: 'heat-slider', kind: 'slider', label: 'Heat', behavior: 'x' },
      { id: 'color-cycle', kind: 'button', label: 'Palette', behavior: 'x' },
    ],
    screenshots: [
      { at: 0, name: 'hero' },
      { at: 2500, name: 'motion' },
    ],
    prompt: 'p',
    probes: null,
    scoringOverrides: null,
    ...overrides,
  };
}

function makeValidation(valid = true): UiArtifactValidationResult {
  return {
    valid,
    errors: valid ? [] : ['boom'],
    warnings: [],
    metadata: {
      sizeBytes: 1000,
      hasDoctype: true,
      hasHtmlTag: true,
      hasManifest: true,
      hasTaskApi: true,
      hasImportMap: true,
      importMapCanonical: true,
      usesThree: true,
      moduleSpecifiers: ['three'],
      externalAssetRefs: [],
      forbiddenApiRefs: [],
      declaredControlIds: ['heat-slider', 'color-cycle'],
    },
  };
}

function makeEvaluation(
  overrides: Partial<UiArtifactEvaluationResult> = {},
): UiArtifactEvaluationResult {
  return {
    ok: true,
    evaluationTimeMs: 1000,
    browser: { executablePath: '/x', viewport: { width: 1280, height: 800 } },
    consoleErrorCount: 0,
    consoleWarningCount: 0,
    consoleSample: [],
    pageErrors: [],
    networkRequestsBlocked: 0,
    vendorRequestsServed: 3,
    startupTimeMs: 900,
    harnessGlobalsMs: 1000,
    webgl: { requestedContexts: ['webgl2'], active: 'webgl2', renderer: 'SwiftShader' },
    fps: 30,
    animation: { detected: true, changedPct: [5, 6] },
    blankFrame: false,
    screenshots: { hero: '/tmp/hero.png', motion: '/tmp/motion.png' },
    probes: [
      { id: 'a', weight: 2, passed: true },
      { id: 'b', weight: 1, passed: true },
    ],
    determinism: { ran: true, replayChangedPct: 0.2, statesMatch: true },
    controlsFound: ['heat-slider', 'color-cycle', 'scene-canvas'],
    viewportFill: true,
    getScoreOk: true,
    destroyOk: true,
    ...overrides,
  };
}

describe('calculateUiScore', () => {
  it('gives a perfect run a perfect score', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation(),
    });
    expect(scores.total).toBe(100);
    expect(scores.interactionPartial).toBe(false);
  });

  it('hard-fails to zero on validation errors', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(false),
      evaluation: makeEvaluation(),
    });
    expect(scores.total).toBe(0);
  });

  it('hard-fails on missing harness globals', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ harnessGlobalsMs: null }),
    });
    expect(scores.total).toBe(0);
  });

  it('hard-fails on a startup page error', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ pageErrors: ['[1200ms] TypeError: boom'] }),
    });
    expect(scores.total).toBe(0);
  });

  it('does NOT hard-fail on a late page error (interaction-time)', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ pageErrors: ['[30000ms] TypeError: later'] }),
    });
    expect(scores.total).toBeGreaterThan(0);
    expect(scores.renderIntegrity).toBeLessThan(100);
  });

  it('hard-fails on blank frames and non-vendor network attempts', () => {
    expect(
      calculateUiScore({
        task: makeTask(),
        validation: makeValidation(),
        evaluation: makeEvaluation({ blankFrame: true }),
      }).total,
    ).toBe(0);
    expect(
      calculateUiScore({
        task: makeTask(),
        validation: makeValidation(),
        evaluation: makeEvaluation({ networkRequestsBlocked: 1 }),
      }).total,
    ).toBe(0);
  });

  it('penalizes a missing WebGL context when the task requires it', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        webgl: { requestedContexts: ['2d'], active: '2d', renderer: null },
      }),
    });
    expect(scores.renderIntegrity).toBe(60);
  });

  it('weights probe results by probe weight', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        probes: [
          { id: 'a', weight: 3, passed: true },
          { id: 'b', weight: 1, passed: false },
        ],
      }),
    });
    expect(scores.interaction).toBe(75);
  });

  it('falls back to control presence and flags partial when probes are unavailable', () => {
    const scores = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ probes: null, controlsFound: ['heat-slider'] }),
    });
    expect(scores.interactionPartial).toBe(true);
    expect(scores.interaction).toBe(50);
  });

  it('scores determinism replay with tolerance bands', () => {
    const perfect = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        determinism: { ran: true, replayChangedPct: 1.0, statesMatch: true },
      }),
    });
    expect(perfect.determinism).toBe(100);

    const half = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        determinism: { ran: true, replayChangedPct: 2.5, statesMatch: true },
      }),
    });
    expect(half.determinism).toBeLessThan(100);
    expect(half.determinism).toBeGreaterThan(50);

    const broken = calculateUiScore({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        determinism: { ran: true, replayChangedPct: 40, statesMatch: false },
      }),
    });
    expect(broken.determinism).toBeCloseTo(33.3, 1);
  });
});
