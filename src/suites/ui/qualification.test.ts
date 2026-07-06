import { describe, expect, it } from 'vitest';

import { assessQualification } from './qualification.js';
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
    errors: valid ? [] : ['External asset reference not allowed: https://cdn.example/x.js'],
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

describe('assessQualification', () => {
  it('qualifies a clean run and records diagnostics as badges', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation(),
    });
    expect(q.qualified).toBe(true);
    expect(q.reasons).toEqual([]);
    expect(q.diagnostics).toMatchObject({
      webglActive: 'webgl2',
      webglRequirementMet: true,
      animationDetected: true,
      controlsDeclared: 2,
      controlsFound: 2,
      determinismOk: true,
      probesPassed: 2,
      probesTotal: 2,
      probesPartial: false,
    });
  });

  it('disqualifies on validation errors', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(false),
      evaluation: makeEvaluation(),
    });
    expect(q.qualified).toBe(false);
    expect(q.reasons.some((r) => r.startsWith('validation:'))).toBe(true);
  });

  it('disqualifies on missing harness globals', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ harnessGlobalsMs: null }),
    });
    expect(q.qualified).toBe(false);
    expect(q.reasons.some((r) => r.startsWith('contract:'))).toBe(true);
  });

  it('disqualifies on startup crash, blank frame, and network attempts', () => {
    for (const overrides of [
      { pageErrors: ['[1200ms] TypeError: boom'] },
      { blankFrame: true },
      { networkRequestsBlocked: 2 },
    ] as const) {
      const q = assessQualification({
        task: makeTask(),
        validation: makeValidation(),
        evaluation: makeEvaluation(overrides),
      });
      expect(q.qualified).toBe(false);
    }
  });

  it('does NOT disqualify on late (interaction-time) page errors', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ pageErrors: ['[30000ms] TypeError: later'] }),
    });
    expect(q.qualified).toBe(true);
  });

  it('missing WebGL is a diagnostic, not a disqualifier', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        webgl: { requestedContexts: ['2d'], active: '2d', renderer: null },
      }),
    });
    expect(q.qualified).toBe(true);
    expect(q.diagnostics.webglRequirementMet).toBe(false);
  });

  it('marks probes partial when the private overlay is unavailable', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({ probes: null }),
    });
    expect(q.qualified).toBe(true);
    expect(q.diagnostics.probesPartial).toBe(true);
    expect(q.diagnostics.probesTotal).toBeNull();
  });

  it('failed probes stay diagnostics — voting decides the grade', () => {
    const q = assessQualification({
      task: makeTask(),
      validation: makeValidation(),
      evaluation: makeEvaluation({
        probes: [
          { id: 'a', weight: 2, passed: false },
          { id: 'b', weight: 1, passed: true },
        ],
      }),
    });
    expect(q.qualified).toBe(true);
    expect(q.diagnostics.probesPassed).toBe(1);
  });
});
