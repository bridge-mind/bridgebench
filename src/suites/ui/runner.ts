/**
 * UI Bench live-model runner: one (model, task) pipeline pass — completion →
 * extract → normalize → validate → evaluate → qualify. It never journals and
 * never throws except ArenaCancellationError (the in-flight pair is abandoned,
 * not journaled); every other failure becomes a fully-populated outcome the
 * orchestrator in run.ts persists.
 */

import type { Browser } from 'playwright-core';

import { ArenaCancellationError, throwIfCancelled } from '../../cancellation.js';
import { MODEL_REGISTRY } from '../../models.js';
import type {
  ChatRequest,
  ModelRegistryEntry,
  ModelRequestPolicy,
  OpenRouterGateway,
} from '../../types.js';
import { UiArtifactEvaluator } from './evaluator/index.js';
import { UiArtifactExtractor } from './extractor.js';
import { UiArtifactNormalizer } from './normalizer.js';
import { buildUiSystemPrompt, buildUiUserPrompt } from './prompt-builder.js';
import { assessQualification } from './qualification.js';
import type { UiArtifactStore } from './store.js';
import type {
  UiArtifactEvaluationResult,
  UiArtifactValidationResult,
  UiBenchFullTask,
  UiQualification,
} from './types.js';
import { UiArtifactValidator } from './validator.js';
import type { UiResultMetrics } from './publish.js';

export type UiRunErrorType =
  'provider_error' | 'validation_error' | 'evaluation_error' | 'runner_error';

/**
 * Every UI Bench model runs under this policy, registry or synthesized. The
 * arena's competitor policy (temp 0, 16k) is wrong here: a full creative HTML
 * document is 10–20k output tokens, and season runs showed reasoning-heavy
 * models truncating below 32k. Reasoning stays excluded so traces never leak
 * into the artifact.
 */
export const UI_BENCH_REQUEST: ModelRequestPolicy = {
  maxTokens: 32_000,
  temperature: 0.7,
  reasoningEffort: 'medium',
  excludeReasoning: true,
  timeoutMs: 600_000,
};

/**
 * Accept ANY OpenRouter slug: registry ids reuse their display metadata,
 * unknown slugs synthesize an entry on the fly (identity round-trips through
 * the journal's modelId, so no preflight against the registry is needed).
 */
export function resolveUiModels(
  slugs: readonly string[],
  names: readonly string[] | undefined,
  overrides: { maxTokens?: number; temperature?: number } = {},
): ModelRegistryEntry[] {
  const cleaned = slugs.map((slug) => slug.trim()).filter(Boolean);
  if (cleaned.length === 0) throw new Error('At least one model slug is required.');
  const duplicates = [...new Set(cleaned.filter((id, index) => cleaned.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new Error(`Model slugs must be unique: ${duplicates.join(', ')}`);
  }
  if (names && names.length > cleaned.length) {
    throw new Error(`Received ${names.length} display names for ${cleaned.length} models.`);
  }

  const request: ModelRequestPolicy = {
    ...UI_BENCH_REQUEST,
    ...(overrides.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }),
    ...(overrides.temperature === undefined ? {} : { temperature: overrides.temperature }),
  };

  return cleaned.map((slug, index) => {
    const registered = MODEL_REGISTRY[slug];
    return {
      id: slug,
      canonicalSlug: registered?.canonicalSlug ?? slug,
      displayName: names?.[index] ?? registered?.displayName ?? slug,
      vendor: registered?.vendor ?? slug.split('/')[0] ?? 'unknown',
      role: 'competitor',
      enabled: true,
      request,
    };
  });
}

/** Season's zeroed validation shape for results with no artifact to inspect. */
export function failureValidation(message: string): UiArtifactValidationResult {
  return {
    valid: false,
    errors: [message],
    warnings: [],
    metadata: {
      sizeBytes: 0,
      hasDoctype: false,
      hasHtmlTag: false,
      hasManifest: false,
      hasTaskApi: false,
      hasImportMap: false,
      importMapCanonical: false,
      usesThree: false,
      moduleSpecifiers: [],
      externalAssetRefs: [],
      forbiddenApiRefs: [],
      declaredControlIds: [],
    },
  };
}

export function failureQualification(task: UiBenchFullTask, reason: string): UiQualification {
  return {
    qualified: false,
    reasons: [reason],
    diagnostics: {
      webglActive: null,
      webglRequirementMet: false,
      fps: null,
      animationDetected: false,
      controlsDeclared: task.controls.length,
      controlsFound: 0,
      viewportFill: false,
      determinismOk: null,
      probesPassed: null,
      probesTotal: null,
      probesPartial: true,
    },
  };
}

export interface UiTaskRunnerDeps {
  gateway: OpenRouterGateway;
  artifactStore: UiArtifactStore;
  extractor?: UiArtifactExtractor;
  normalizer?: UiArtifactNormalizer;
  validator?: UiArtifactValidator;
  createEvaluator?: (browser: Browser) => UiArtifactEvaluator;
}

export interface UiTaskRunContext {
  model: ModelRegistryEntry;
  task: UiBenchFullTask;
  /** null = --dry: generate and validate only, skip browser evaluation. */
  browser: Browser | null;
  executablePath: string;
  signal?: AbortSignal;
  onProgress?: (phase: 'generated' | 'evaluating', detail: string) => void;
}

export interface UiTaskOutcome {
  /** Normalized HTML, or null when the provider call failed outright. */
  html: string | null;
  validation: UiArtifactValidationResult;
  evaluation: UiArtifactEvaluationResult | null;
  qualification: UiQualification;
  metrics: UiResultMetrics;
  /** Mirrors qualification.qualified — drives the --resume skip set. */
  success: boolean;
  errorType?: UiRunErrorType;
  finishReason?: string;
  generationId?: string;
}

export class UiTaskRunner {
  private readonly gateway: OpenRouterGateway;
  private readonly artifactStore: UiArtifactStore;
  private readonly extractor: UiArtifactExtractor;
  private readonly normalizer: UiArtifactNormalizer;
  private readonly validator: UiArtifactValidator;
  private readonly createEvaluator: (browser: Browser) => UiArtifactEvaluator;

  constructor(deps: UiTaskRunnerDeps) {
    this.gateway = deps.gateway;
    this.artifactStore = deps.artifactStore;
    this.extractor = deps.extractor ?? new UiArtifactExtractor();
    this.normalizer = deps.normalizer ?? new UiArtifactNormalizer();
    this.validator = deps.validator ?? new UiArtifactValidator();
    this.createEvaluator = deps.createEvaluator ?? ((browser) => new UiArtifactEvaluator(browser));
  }

  async runTask(ctx: UiTaskRunContext): Promise<UiTaskOutcome> {
    throwIfCancelled(ctx.signal);
    const { task, model } = ctx;

    const request: ChatRequest = {
      model,
      system: buildUiSystemPrompt(task),
      user: buildUiUserPrompt(task),
      signal: ctx.signal,
    };

    const startedAt = Date.now();
    let completion;
    try {
      completion = await this.gateway.complete(request);
    } catch (error) {
      if (error instanceof ArenaCancellationError || ctx.signal?.aborted) {
        throw new ArenaCancellationError();
      }
      const message = `provider error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        html: null,
        validation: failureValidation(message),
        evaluation: null,
        qualification: failureQualification(task, message),
        metrics: {
          providerResponseMs: Date.now() - startedAt,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
        success: false,
        errorType: 'provider_error',
      };
    }

    const metrics: UiResultMetrics = {
      providerResponseMs: completion.latencyMs,
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      costUsd: completion.costUsd,
    };
    const audit = { generationId: completion.generationId, finishReason: completion.finishReason };
    ctx.onProgress?.(
      'generated',
      `${completion.content.length} chars in ${(completion.latencyMs / 1000).toFixed(1)}s ` +
        `($${completion.costUsd.toFixed(4)}, ${completion.inputTokens} in / ${completion.outputTokens} out)` +
        (completion.finishReason === 'length' ? ' [truncated at max tokens]' : ''),
    );

    let normalizedHtml: string;
    let validation: UiArtifactValidationResult;
    let auditDir: string;
    try {
      const extraction = this.extractor.extract(completion.content);
      normalizedHtml = this.normalizer.normalize(extraction.html, {
        taskTitle: task.title,
        modelName: model.displayName,
      });
      validation = this.validator.validateHtml(normalizedHtml, task);
      const record = await this.artifactStore.writeArtifact({
        modelId: model.id,
        displayName: model.displayName,
        task,
        html: extraction.html,
        normalizedHtml,
        rawResponse: completion.content,
        ...metrics,
        validation,
        ...audit,
      });
      auditDir = record.paths.dir;
    } catch (error) {
      const message = `runner error: ${error instanceof Error ? error.message : String(error)}`;
      return {
        html: null,
        validation: failureValidation(message),
        evaluation: null,
        qualification: failureQualification(task, message),
        metrics,
        success: false,
        errorType: 'runner_error',
        ...audit,
      };
    }

    let evaluation: UiArtifactEvaluationResult | null = null;
    let evaluationThrew = false;
    if (validation.valid && ctx.browser) {
      throwIfCancelled(ctx.signal);
      ctx.onProgress?.('evaluating', '');
      try {
        evaluation = await this.createEvaluator(ctx.browser).evaluate({
          html: normalizedHtml,
          task,
          outputDir: auditDir,
          executablePath: ctx.executablePath,
        });
      } catch (error) {
        // The orchestrator's abort listener closes the shared browser under
        // us; an evaluator crash after a cancel request is the cancel, not a
        // result.
        if (ctx.signal?.aborted) throw new ArenaCancellationError();
        evaluation = null;
        evaluationThrew = true;
        void error;
      }
    }

    const qualification = assessQualification({ task, validation, evaluation });
    const errorType: UiRunErrorType | undefined = !validation.valid
      ? 'validation_error'
      : evaluationThrew || (evaluation !== null && !evaluation.ok)
        ? 'evaluation_error'
        : undefined;

    return {
      html: normalizedHtml,
      validation,
      evaluation,
      qualification,
      metrics,
      success: qualification.qualified,
      ...(errorType === undefined ? {} : { errorType }),
      ...audit,
    };
  }
}
