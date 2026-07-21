import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ArenaCancellationError } from '../src/cancellation.js';
import { REPO_ROOT } from '../src/config.js';
import { MockOpenRouterGateway } from '../src/mock-gateway.js';
import { MODEL_REGISTRY } from '../src/models.js';
import {
  failureQualification,
  failureValidation,
  resolveUiModels,
  UI_BENCH_REQUEST,
  UiTaskRunner,
} from '../src/suites/ui/runner.js';
import { UiArtifactStore } from '../src/suites/ui/store.js';
import type { UiBenchFullTask } from '../src/suites/ui/types.js';
import type { ModelCompletion, OpenRouterGateway } from '../src/types.js';

const GOLDEN_HTML = readFileSync(path.join(REPO_ROOT, 'fixtures', 'golden-correct.html'), 'utf8');

function makeTask(overrides: Partial<UiBenchFullTask> = {}): UiBenchFullTask {
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
      { at: 2500, name: 'motion' },
    ],
    prompt: 'p',
    probes: null,
    scoringOverrides: null,
    ...overrides,
  };
}

function completion(content: string, overrides: Partial<ModelCompletion> = {}): ModelCompletion {
  return {
    generationId: 'gen-1',
    content,
    inputTokens: 312,
    outputTokens: 15_872,
    costUsd: 0.4213,
    latencyMs: 84_200,
    finishReason: 'stop',
    attempts: 1,
    ...overrides,
  };
}

function stubGateway(handler: OpenRouterGateway['complete']): OpenRouterGateway {
  return { complete: handler, validateModel: async () => {} };
}

let tempDirs: string[] = [];

function tempStore(): UiArtifactStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-runner-test-'));
  tempDirs.push(dir);
  return new UiArtifactStore(dir);
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('resolveUiModels', () => {
  it('synthesizes an entry for an unknown OpenRouter slug under the UI policy', () => {
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    expect(model).toMatchObject({
      id: 'acme/super-coder-9',
      canonicalSlug: 'acme/super-coder-9',
      displayName: 'acme/super-coder-9',
      vendor: 'acme',
      role: 'competitor',
      enabled: true,
      request: UI_BENCH_REQUEST,
    });
  });

  it('reuses registry display metadata but never the arena request policy', () => {
    const [model] = resolveUiModels(['openai/gpt-5.6-sol'], undefined, {});
    expect(model!.displayName).toBe(MODEL_REGISTRY['openai/gpt-5.6-sol']!.displayName);
    expect(model!.request).toEqual(UI_BENCH_REQUEST);
    expect(model!.request.temperature).not.toBe(
      MODEL_REGISTRY['openai/gpt-5.6-sol']!.request.temperature,
    );
  });

  it('applies max-tokens and temperature overrides and positional names', () => {
    const models = resolveUiModels(['a/one', 'b/two'], ['One'], {
      maxTokens: 9_000,
      temperature: 0,
    });
    expect(models[0]!.displayName).toBe('One');
    expect(models[1]!.displayName).toBe('b/two');
    expect(models[0]!.request).toMatchObject({ maxTokens: 9_000, temperature: 0 });
  });

  it('rejects duplicates and surplus display names', () => {
    expect(() => resolveUiModels(['a/one', 'a/one'], undefined, {})).toThrow(/unique/);
    expect(() => resolveUiModels(['a/one'], ['One', 'Two'], {})).toThrow(/display names/);
  });
});

describe('UiTaskRunner', () => {
  it('maps a successful completion to real metrics and a validated artifact', async () => {
    const runner = new UiTaskRunner({
      gateway: stubGateway(async () => completion(GOLDEN_HTML)),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    const outcome = await runner.runTask({
      model: model!,
      task: makeTask(),
    });

    expect(outcome.metrics).toEqual({
      providerResponseMs: 84_200,
      inputTokens: 312,
      outputTokens: 15_872,
      costUsd: 0.4213,
    });
    expect(outcome.html).toContain('<!doctype html>');
    expect(outcome.validation.valid).toBe(true);
    // Live runs qualify against the static artifact contract. Runtime browser
    // diagnostics are available only through the explicit `ui evaluate` path.
    expect(outcome.evaluation).toBeNull();
    expect(outcome.qualification.qualified).toBe(true);
    expect(outcome.success).toBe(true);
    expect(outcome.errorType).toBeUndefined();
    expect(outcome.generationId).toBe('gen-1');
  });

  it('forwards model deltas as observable streaming progress', async () => {
    const runner = new UiTaskRunner({
      gateway: stubGateway(async (request) => {
        request.onDelta?.(GOLDEN_HTML.slice(0, 128));
        request.onDelta?.(GOLDEN_HTML);
        return completion(GOLDEN_HTML);
      }),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    const progress: string[] = [];

    await runner.runTask({
      model: model!,
      task: makeTask(),
      onProgress: (phase, detail) => progress.push(`${phase}:${detail}`),
    });

    expect(progress).toContain('streaming:128 chars received');
    expect(progress.some((entry) => entry.startsWith('generated:'))).toBe(true);
  });

  it('journals a provider failure as provider_error with wall-clock latency', async () => {
    const runner = new UiTaskRunner({
      gateway: stubGateway(async () => {
        throw new Error('OpenRouter returned an empty completion');
      }),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    const outcome = await runner.runTask({
      model: model!,
      task: makeTask(),
    });

    expect(outcome.errorType).toBe('provider_error');
    expect(outcome.html).toBeNull();
    expect(outcome.success).toBe(false);
    expect(outcome.validation.valid).toBe(false);
    expect(outcome.qualification.reasons[0]).toMatch(/provider error: OpenRouter returned/);
    expect(outcome.metrics.costUsd).toBe(0);
    expect(outcome.metrics.providerResponseMs).toBeGreaterThanOrEqual(0);
  });

  it('marks prose-only completions as validation_error without touching a browser', async () => {
    const runner = new UiTaskRunner({
      gateway: stubGateway(async () => completion('Here is my plan, no HTML today.')),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    const outcome = await runner.runTask({
      model: model!,
      task: makeTask(),
    });

    expect(outcome.errorType).toBe('validation_error');
    expect(outcome.success).toBe(false);
    expect(outcome.metrics.costUsd).toBe(0.4213);
  });

  it('surfaces truncation via finishReason', async () => {
    const runner = new UiTaskRunner({
      gateway: stubGateway(async () => completion(GOLDEN_HTML, { finishReason: 'length' })),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    const detail: string[] = [];
    const outcome = await runner.runTask({
      model: model!,
      task: makeTask(),
      onProgress: (phase, text) => detail.push(`${phase}:${text}`),
    });
    expect(outcome.finishReason).toBe('length');
    expect(detail.some((entry) => entry.includes('[truncated at max tokens]'))).toBe(true);
  });

  it('throws ArenaCancellationError on a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new UiTaskRunner({
      gateway: new MockOpenRouterGateway({ competitorText: GOLDEN_HTML, chunkDelayMs: 1 }),
      artifactStore: tempStore(),
    });
    const [model] = resolveUiModels(['acme/super-coder-9'], undefined, {});
    await expect(
      runner.runTask({
        model: model!,
        task: makeTask(),
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ArenaCancellationError);
  });
});

describe('failure shapes', () => {
  it('builds a zeroed validation and qualification for artifact-less failures', () => {
    const task = makeTask();
    const validation = failureValidation('provider error: boom');
    const qualification = failureQualification(task, 'provider error: boom');
    expect(validation.valid).toBe(false);
    expect(validation.metadata.sizeBytes).toBe(0);
    expect(qualification.qualified).toBe(false);
    expect(qualification.diagnostics.controlsDeclared).toBe(task.controls.length);
    expect(qualification.diagnostics.probesPartial).toBe(true);
  });
});
