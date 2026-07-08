/**
 * Calls the model provider for a UI Bench task and returns the raw response
 * plus token/cost/timing accounting. Ported from the proven legacy runner:
 * streaming with retry/backoff, and a per-model tuning table that keeps
 * reasoning traces out of (or from truncating) the HTML artifact.
 */

import {
  calculateCost,
  createProvider,
  getDisplayName,
  getModelEntry,
} from '../../providers/index.js';
import type { BaseProvider, ModelRequestTuning } from '../../providers/index.js';
import { getRunLogger } from '../../logger.js';
import { buildUiTaskPrompt } from './prompt-builder.js';
import type { UiBenchTask } from './types.js';

export interface UiModelResponse {
  rawResponse: string;
  providerResponseMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UiRunnerConfig {
  modelId: string;
  displayName?: string;
  apiKeys?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  retryBaseDelayMs?: number;
}

function isDirectZaiModel(modelId: string): boolean {
  return modelId.startsWith('z-ai/glm-');
}

// GLM 5.x thinks by default; routed through OpenRouter, the reasoning trace
// bills against max_tokens and can consume the entire budget before any HTML
// is emitted. OpenRouter's normalized `reasoning.enabled: false` maps to
// Z.ai's `thinking: { type: 'disabled' }`.
function isOpenRouterZaiModel(modelId: string): boolean {
  return modelId.startsWith('openrouter/z-ai/glm-');
}

function isReasoningHeavyModel(modelId: string): boolean {
  return /xiaomi\/mimo/i.test(modelId);
}

// Kimi K2.x (via OpenRouter) emits reasoning tokens. Without excluding/capping
// reasoning, the trace either leaks ahead of the HTML (extractor captures
// prose) or consumes the entire budget so the response truncates before the
// mandatory BridgeBench harness globals. Minimal + excluded reasoning plus a
// larger ceiling lets a complete HTML document come back.
function isOpenRouterKimiModel(modelId: string): boolean {
  return /^openrouter\/moonshotai\/kimi-/.test(modelId);
}

// Anthropic reasoning models (via OpenRouter) emit reasoning tokens that count
// against max_tokens but are excluded from message.content unless explicitly
// excluded. Without tuning, the model burns the budget on reasoning and
// returns empty or truncated HTML.
function isOpenRouterAnthropicReasoningUiModel(modelId: string): boolean {
  return /^openrouter\/anthropic\/claude-(?:sonnet-5|opus-4\.8|fable-5)$/.test(modelId);
}

// Gemini 3.x cannot disable thinking. Without excluding reasoning, planning
// prose leaks into the response ahead of (or instead of) the HTML. Exclude/cap
// reasoning and force non-streaming so a clean HTML document comes back.
function isDirectGeminiModel(modelId: string): boolean {
  return /^google\/gemini-/.test(modelId);
}

function isOpenRouterGeminiModel(modelId: string): boolean {
  return /^openrouter\/google\/gemini-/.test(modelId);
}

function tuneUiRequest(modelId: string): ModelRequestTuning {
  // A per-model tuning block on the registry entry wins over the
  // family-wide pattern fallbacks below.
  const registryTuning = getModelEntry(modelId)?.tuning;
  if (registryTuning) return registryTuning;

  if (isDirectZaiModel(modelId)) {
    return {
      requestBodyOverrides: {
        thinking: { type: 'disabled' },
      },
    };
  }

  if (isOpenRouterZaiModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning: { enabled: false },
      },
    };
  }

  if (isDirectGeminiModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning_effort: 'low',
      },
      forceNonStreaming: true,
    };
  }

  if (isOpenRouterGeminiModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning: { effort: 'low', exclude: true },
      },
      forceNonStreaming: true,
    };
  }

  if (isReasoningHeavyModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning: { effort: 'none' },
      },
    };
  }

  if (isOpenRouterKimiModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning: { effort: 'minimal', exclude: true },
      },
      maxTokens: 32_000,
    };
  }

  if (isOpenRouterAnthropicReasoningUiModel(modelId)) {
    return {
      requestBodyOverrides: {
        reasoning: { effort: 'minimal', exclude: true },
      },
      maxTokens: 32_000,
    };
  }

  return {};
}

const RETRYABLE_ERROR_PATTERNS = [
  /connection error/i,
  /rate limit/i,
  /\b429\b/,
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /eai_again/i,
  /etimedout/i,
  /socket hang up/i,
  /overloaded/i,
  /operation was aborted/i,
  // Transient upstream/gateway failures (OpenRouter surfaces these as bare
  // status text) — retrying is the correct response.
  /internal server error/i,
  /bad gateway/i,
  /service unavailable/i,
  /gateway timeout/i,
  /\b(?:500|502|503|504)\b/,
  /premature close/i,
];

function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UiModelRunner {
  readonly modelId: string;
  readonly displayName: string;
  readonly maxTokens: number;
  readonly temperature: number;
  private readonly provider: BaseProvider;
  private readonly apiModel: string;
  private readonly retryBaseDelayMs: number;

  constructor(config: UiRunnerConfig) {
    this.modelId = config.modelId;
    this.displayName = config.displayName ?? getDisplayName(config.modelId);
    this.maxTokens = config.maxTokens ?? 16_000;
    this.temperature = config.temperature ?? 0.7;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 5_000;

    const resolved = createProvider(config.modelId, config.apiKeys);
    this.provider = resolved.provider;
    this.apiModel = resolved.apiModel;
  }

  async runTask(task: UiBenchTask): Promise<UiModelResponse> {
    const logger = getRunLogger().child({ model: this.modelId, task: task.id });
    const tuned = tuneUiRequest(this.modelId);
    const maxTokens = tuned.maxTokens ?? this.maxTokens;
    const temperature = tuned.temperature ?? this.temperature;
    const prompt = buildUiTaskPrompt(task);

    logger.debug('provider.request', {
      apiModel: this.apiModel,
      provider: this.provider.name,
      maxTokens,
      temperature,
      requestBodyOverrides: tuned.requestBodyOverrides ?? null,
      forceNonStreaming: tuned.forceNonStreaming ?? false,
      tuningSource: getModelEntry(this.modelId)?.tuning ? 'registry' : 'pattern-fallback',
      promptChars: prompt.length,
      prompt,
    });

    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let rawResponse = '';
      let providerCostUsd: number | undefined;
      let chunkCount = 0;
      let firstContentMs: number | null = null;
      let lastProgressLog = startedAt;

      try {
        for await (const chunk of this.provider.stream({
          model: this.apiModel,
          prompt,
          maxTokens,
          temperature,
          requestBodyOverrides: tuned.requestBodyOverrides,
          forceNonStreaming: tuned.forceNonStreaming,
        })) {
          chunkCount++;
          if (chunk.content) {
            if (firstContentMs === null) {
              firstContentMs = Date.now() - startedAt;
              logger.debug('provider.stream.first-content', { attempt, ttfcMs: firstContentMs });
            }
            rawResponse += chunk.content;
          }
          if (chunk.inputTokens !== undefined) inputTokens = chunk.inputTokens;
          if (chunk.outputTokens !== undefined) outputTokens = chunk.outputTokens;
          if (chunk.costUsd !== undefined) providerCostUsd = chunk.costUsd;

          if (Date.now() - lastProgressLog >= 5_000) {
            lastProgressLog = Date.now();
            logger.debug('provider.stream.progress', {
              attempt,
              elapsedMs: Date.now() - startedAt,
              chunks: chunkCount,
              chars: rawResponse.length,
            });
          }
        }

        const response = {
          rawResponse,
          providerResponseMs: Date.now() - startedAt,
          inputTokens,
          outputTokens,
          costUsd:
            providerCostUsd ?? calculateCost(this.apiModel, inputTokens, outputTokens),
        };
        logger.info('provider.response', {
          attempt,
          providerResponseMs: response.providerResponseMs,
          ttfcMs: firstContentMs,
          chunks: chunkCount,
          responseChars: rawResponse.length,
          inputTokens,
          outputTokens,
          costUsd: response.costUsd,
          costSource: providerCostUsd !== undefined ? 'provider-reported' : 'static-pricing',
        });
        if (rawResponse.length === 0) {
          logger.warn('provider.response.empty', {
            attempt,
            outputTokens,
            hint: 'output tokens spent with no content usually means the budget went to reasoning — check tuning',
          });
        }
        return response;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === maxAttempts || !isRetryableError(error)) {
          logger.error('provider.request.failed', {
            attempt,
            maxAttempts,
            retryable: isRetryableError(error),
            error: message,
            stack: error instanceof Error ? error.stack : undefined,
            partialChars: rawResponse.length,
          });
          throw error;
        }

        const backoffMs = this.retryBaseDelayMs * attempt;
        logger.warn('provider.retry', {
          attempt,
          maxAttempts,
          backoffMs,
          error: message,
          partialChars: rawResponse.length,
        });
        await sleep(backoffMs);
      }
    }

    throw new Error(`Exhausted retries for ${this.modelId} on ${task.id}`);
  }
}
