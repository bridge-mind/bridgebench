import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildUiRunDescriptor,
  journalUiEvaluation,
  publishSingleUiResult,
  uiJournalPath,
  uiResultsRoot,
} from '../src/suites/ui/publish.js';
import { failureQualification, failureValidation } from '../src/suites/ui/runner.js';
import { assessQualification } from '../src/suites/ui/qualification.js';
import type {
  UiArtifactEvaluationResult,
  UiArtifactValidationResult,
  UiBenchFullTask,
} from '../src/suites/ui/types.js';
import { ENGINE_VERSION } from '../src/version.js';
import { THREE_VERSION } from '../src/config.js';

const apiConfig = {
  baseUrl: 'http://127.0.0.1:8083',
  adminKey: 'test-admin-key',
  timeoutMs: 1_000,
};

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
    errors: valid ? [] : ['nope'],
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

function makeEvaluation(screenshots: Record<string, string>): UiArtifactEvaluationResult {
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
    screenshots,
    probes: null,
    determinism: { ran: true, replayChangedPct: 0.2, statesMatch: true },
    controlsFound: ['heat-slider', 'color-cycle'],
    viewportFill: true,
    getScoreOk: true,
    destroyOk: true,
  };
}

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-publish-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('uiResultsRoot', () => {
  it('separates mock journals and honors BRIDGEBENCH_RESULTS_DIR at call time', () => {
    expect(uiResultsRoot(true).endsWith(path.join('ui-mock'))).toBe(true);
    expect(uiResultsRoot(false).endsWith(path.join('ui'))).toBe(true);
    vi.stubEnv('BRIDGEBENCH_RESULTS_DIR', '/writable/results');
    expect(uiResultsRoot()).toBe(path.join('/writable/results', 'ui'));
  });
});

describe('journalUiEvaluation', () => {
  it('keeps the historical ui evaluate defaults (zeros, success:true)', async () => {
    const root = tempRoot();
    const task = makeTask();
    const validation = makeValidation();
    const { line, journalPath } = await journalUiEvaluation({
      task,
      modelId: 'reference',
      html: '<!DOCTYPE html><html><body>x</body></html>',
      validation,
      evaluation: null,
      qualification: assessQualification({ task, validation, evaluation: null }),
      resultsRoot: root,
    });
    expect(line).toMatchObject({
      modelId: 'reference',
      displayName: 'reference',
      providerResponseMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      success: true,
    });
    expect(line.errorType).toBeUndefined();
    expect(line.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(line.artifactPaths.html)).toBe(true);
    expect(journalPath).toBe(uiJournalPath(root));
    expect(readFileSync(journalPath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('persists real metrics, errorType, and display name for live-run lines', async () => {
    const root = tempRoot();
    const task = makeTask();
    const source = path.join(root, 'hero-src.png');
    writeFileSync(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const validation = makeValidation();
    const evaluation = makeEvaluation({ hero: source });
    const { line } = await journalUiEvaluation({
      task,
      modelId: 'acme/super-coder-9',
      displayName: 'Super Coder 9',
      html: '<!DOCTYPE html><html><body>x</body></html>',
      validation,
      evaluation,
      qualification: assessQualification({ task, validation, evaluation }),
      metrics: {
        providerResponseMs: 84_200,
        inputTokens: 312,
        outputTokens: 15_872,
        costUsd: 0.42,
      },
      success: true,
      resultsRoot: root,
    });
    expect(line).toMatchObject({
      displayName: 'Super Coder 9',
      providerResponseMs: 84_200,
      inputTokens: 312,
      outputTokens: 15_872,
      costUsd: 0.42,
    });
    // Gallery screenshots are copied to stable publish paths.
    expect(Object.keys(line.artifactPaths.screenshots)).toEqual(['hero']);
    expect(existsSync(line.artifactPaths.screenshots.hero!)).toBe(true);
  });

  it('journals provider failures with no artifact and a null sha', async () => {
    const root = tempRoot();
    const task = makeTask();
    const { line } = await journalUiEvaluation({
      task,
      modelId: 'acme/super-coder-9',
      html: null,
      validation: failureValidation('provider error: boom'),
      evaluation: null,
      qualification: failureQualification(task, 'provider error: boom'),
      success: false,
      errorType: 'provider_error',
      resultsRoot: root,
    });
    expect(line.artifactSha256).toBeNull();
    expect(line.artifactPaths).toEqual({ html: '', screenshots: {} });
    expect(line.errorType).toBe('provider_error');
    expect(line.success).toBe(false);
  });
});

describe('publishSingleUiResult', () => {
  async function journalGoldenLine(root: string) {
    const task = makeTask();
    const validation = makeValidation();
    const { line } = await journalUiEvaluation({
      task,
      modelId: 'acme/super-coder-9',
      html: '<!DOCTYPE html><html><body>x</body></html>',
      validation,
      evaluation: null,
      qualification: assessQualification({ task, validation, evaluation: null }),
      metrics: { providerResponseMs: 100, inputTokens: 1, outputTokens: 2, costUsd: 0.01 },
      success: false,
      errorType: 'evaluation_error',
      resultsRoot: root,
    });
    return line;
  }

  it('posts one self-contained request with the engine-owned run descriptor', async () => {
    const root = tempRoot();
    const line = await journalGoldenLine(root);
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(String(url)).toBe('http://127.0.0.1:8083/ui-bench/results/import');
        expect((init?.headers as Record<string, string>)['x-bridgebench-admin-key']).toBe(
          'test-admin-key',
        );
        bodies.push(init?.body as string);
        return new Response(
          JSON.stringify({ importedResults: 1, skippedResults: 0, importedArtifacts: 1 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const run = buildUiRunDescriptor('ui-test-20260715', 1);
    expect(run).toEqual({
      runKey: 'ui-test-20260715',
      season: 1,
      engineVersion: ENGINE_VERSION,
      threeVersion: THREE_VERSION,
    });

    const outcome = await publishSingleUiResult(line, run, apiConfig);
    expect(outcome).toEqual({
      importedResults: 1,
      skippedResults: 0,
      importedArtifacts: 1,
      results: 1,
    });

    const body = JSON.parse(bodies[0]!);
    expect(body.run).toEqual(run);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].id).toBe('s1-lava-lamp-redux');
    expect(body.tasks[0].publicHash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toMatchObject({
      modelId: 'acme/super-coder-9',
      errorType: 'evaluation_error',
      artifactHtml: '<!DOCTYPE html><html><body>x</body></html>',
    });

    // Byte-identical retry: the journal line re-reads the same on-disk bytes.
    await publishSingleUiResult(line, run, apiConfig);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('surfaces server 409 conflicts in the thrown message', async () => {
    const root = tempRoot();
    const line = await journalGoldenLine(root);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode: 409, message: 'content drift' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(
      publishSingleUiResult(line, buildUiRunDescriptor('ui-test-20260715', 1), apiConfig),
    ).rejects.toThrow(/→ 409:/);
  });
});
