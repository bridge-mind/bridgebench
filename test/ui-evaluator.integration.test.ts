/**
 * Full-pipeline integration tests: real Chromium (SwiftShader WebGL), the
 * golden fixtures, the probe DSL, and Phase B determinism. Skipped when no
 * Chromium executable is available.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser } from 'playwright-core';

import { REPO_ROOT } from '../src/config.js';
import {
  UiArtifactEvaluator,
  launchEvalBrowser,
  resolveChromiumExecutablePath,
} from '../src/suites/ui/evaluator/index.js';
import { UiArtifactNormalizer } from '../src/suites/ui/normalizer.js';
import { assessQualification } from '../src/suites/ui/qualification.js';
import { UiArtifactValidator } from '../src/suites/ui/validator.js';
import type { UiBenchFullTask, UiProbe } from '../src/suites/ui/types.js';

let chromiumAvailable = true;
try {
  resolveChromiumExecutablePath();
} catch {
  chromiumAvailable = false;
}

const LAVA_PROBES: UiProbe[] = [
  {
    id: 'heat-slider-changes-motion',
    weight: 2,
    steps: [
      { action: 'reset', seed: 7 },
      { action: 'waitMs', ms: 800 },
      { action: 'snapshot', name: 'before' },
      { action: 'getState', name: 's0' },
      { action: 'setSlider', selector: "[data-bb-control='heat-slider']", fraction: 1 },
      { action: 'waitMs', ms: 400 },
    ],
    asserts: [
      {
        anyOf: [
          { type: 'pixelDeltaVs', ref: 'before', minChangedPct: 1 },
          { type: 'stateChangedVs', ref: 's0', path: 'heat' },
        ],
      },
    ],
  },
  {
    id: 'palette-button-shifts-colors',
    weight: 2,
    steps: [
      { action: 'snapshot', name: 'before' },
      { action: 'getState', name: 's0' },
      { action: 'click', selector: "[data-bb-control='color-cycle']" },
      { action: 'waitMs', ms: 400 },
    ],
    asserts: [
      {
        anyOf: [
          { type: 'hueShiftVs', ref: 'before', minDegrees: 25 },
          { type: 'stateChangedVs', ref: 's0', path: 'palette' },
        ],
      },
    ],
  },
  {
    id: 'state-is-sane',
    weight: 1,
    steps: [{ action: 'getState', name: 's' }],
    asserts: [{ type: 'stateSerializable' }, { type: 'statePathExists', path: 'blobs' }],
  },
];

function makeLavaTask(probes: UiProbe[] | null): UiBenchFullTask {
  return {
    id: 's1-lava-lamp-redux',
    season: 1,
    title: 'Lava Lamp',
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
      { at: 1500, name: 'motion' },
    ],
    prompt: 'p',
    probes,
    // SwiftShader's WebGL rasterization varies slightly across CI hosts.
    // The replay must still preserve the fixture's exact logical state.
    scoringOverrides: { determinismMaxChangedPct: 5 },
  };
}

function fixture(name: string): string {
  return readFileSync(path.join(REPO_ROOT, 'fixtures', name), 'utf8');
}

describe.skipIf(!chromiumAvailable)('UiArtifactEvaluator (integration)', () => {
  let browser: Browser;
  let executablePath: string;
  const normalizer = new UiArtifactNormalizer();
  const validator = new UiArtifactValidator();

  beforeAll(async () => {
    const launched = await launchEvalBrowser();
    browser = launched.browser;
    executablePath = launched.executablePath;
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('golden-correct: renders WebGL, animates, passes probes, replays deterministically', async () => {
    const task = makeLavaTask(LAVA_PROBES);
    const html = normalizer.normalize(fixture('golden-correct.html'), {
      taskTitle: task.title,
      modelName: 'fixture',
    });
    const validation = validator.validateHtml(html, task);
    expect(validation.valid).toBe(true);

    const evaluator = new UiArtifactEvaluator(browser);
    const outputDir = mkdtempSync(path.join(tmpdir(), 'bb-eval-'));
    const evaluation = await evaluator.evaluate({ html, task, outputDir, executablePath });

    expect(evaluation.ok).toBe(true);
    expect(evaluation.harnessGlobalsMs).not.toBeNull();
    expect(['webgl', 'webgl2']).toContain(evaluation.webgl.active);
    expect(evaluation.blankFrame).toBe(false);
    expect(evaluation.animation.detected).toBe(true);
    expect(evaluation.networkRequestsBlocked).toBe(0);
    expect(evaluation.vendorRequestsServed).toBeGreaterThan(0);
    expect(evaluation.controlsFound).toEqual(
      expect.arrayContaining(['heat-slider', 'color-cycle']),
    );
    expect(evaluation.viewportFill).toBe(true);
    expect(evaluation.screenshots.hero).toBeTruthy();

    expect(evaluation.probes).not.toBeNull();
    for (const probe of evaluation.probes!) {
      expect(probe, `probe ${probe.id}: ${probe.details ?? probe.error ?? ''}`).toMatchObject({
        passed: true,
      });
    }

    expect(evaluation.determinism.ran).toBe(true);
    expect(evaluation.determinism.replayChangedPct).not.toBeNull();
    expect(evaluation.determinism.replayChangedPct!).toBeLessThanOrEqual(
      task.scoringOverrides?.determinismMaxChangedPct ?? 1.5,
    );
    expect(evaluation.determinism.statesMatch).toBe(true);

    const qualification = assessQualification({ task, validation, evaluation });
    expect(qualification.qualified).toBe(true);
    expect(qualification.reasons).toEqual([]);
    expect(qualification.diagnostics.determinismOk).toBe(true);
    expect(qualification.diagnostics.probesPartial).toBe(false);
    expect(qualification.diagnostics.probesPassed).toBe(qualification.diagnostics.probesTotal);
  }, 180_000);

  it('golden-broken: hard-fails (startup page error + blank frame)', async () => {
    const task = makeLavaTask(null);
    const html = normalizer.normalize(fixture('golden-broken.html'), {
      taskTitle: task.title,
      modelName: 'fixture',
    });
    const validation = validator.validateHtml(html, task);
    expect(validation.valid).toBe(true); // statically fine — dies at runtime

    const evaluator = new UiArtifactEvaluator(browser);
    const outputDir = mkdtempSync(path.join(tmpdir(), 'bb-eval-'));
    const evaluation = await evaluator.evaluate({ html, task, outputDir, executablePath });

    expect(evaluation.pageErrors.length).toBeGreaterThan(0);
    expect(evaluation.blankFrame).toBe(true);

    const qualification = assessQualification({ task, validation, evaluation });
    expect(qualification.qualified).toBe(false);
    expect(qualification.reasons.length).toBeGreaterThan(0);
  }, 120_000);

  it('golden-cheating: never reaches the browser (validator rejects)', () => {
    const task = makeLavaTask(null);
    const html = normalizer.normalize(fixture('golden-cheating.html'), {
      taskTitle: task.title,
      modelName: 'fixture',
    });
    const validation = validator.validateHtml(html, task);
    expect(validation.valid).toBe(false);

    const qualification = assessQualification({ task, validation, evaluation: null });
    expect(qualification.qualified).toBe(false);
  });
});
