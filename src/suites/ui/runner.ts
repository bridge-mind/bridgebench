/**
 * Calls the model provider for a UI Bench task and returns the raw response
 * plus token/cost/timing accounting. Ported from the proven legacy runner:
 * streaming with retry/backoff, and a per-model tuning table that keeps
 * reasoning traces out of (or from truncating) the HTML artifact.
 */

import { calculateCost, createProvider, getDisplayName } from '../../providers/index.js';
import type { BaseProvider } from '../../providers/index.js';
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

interface UiRequestTuning {
  requestBodyOverrides?: Record<string, unknown>;
  forceNonStreaming?: boolean;
  /** Per-model completion ceiling; overrides the runner default when set. */
  maxTokens?: number;
}

function isDirectZaiModel(modelId: string): boolean {
  return modelId.startsWith('z-ai/glm-');
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

function tuneUiRequest(modelId: string): UiRequestTuning {
  if (isDirectZaiModel(modelId)) {
    return {
      requestBodyOverrides: {
        thinking: { type: 'disabled' },
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
    const tuned = tuneUiRequest(this.modelId);
    const maxTokens = tuned.maxTokens ?? this.maxTokens;
    const prompt = buildUiTaskPrompt(task);

    const maxAttempts = 6;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const startedAt = Date.now();
      let inputTokens = 0;
      let outputTokens = 0;
      let rawResponse = '';
      let providerCostUsd: number | undefined;

      try {
        for await (const chunk of this.provider.stream({
          model: this.apiModel,
          prompt,
          maxTokens,
          temperature: this.temperature,
          requestBodyOverrides: tuned.requestBodyOverrides,
          forceNonStreaming: tuned.forceNonStreaming,
        })) {
          if (chunk.content) rawResponse += chunk.content;
          if (chunk.inputTokens !== undefined) inputTokens = chunk.inputTokens;
          if (chunk.outputTokens !== undefined) outputTokens = chunk.outputTokens;
          if (chunk.costUsd !== undefined) providerCostUsd = chunk.costUsd;
        }

        return {
          rawResponse,
          providerResponseMs: Date.now() - startedAt,
          inputTokens,
          outputTokens,
          costUsd:
            providerCostUsd ?? calculateCost(this.apiModel, inputTokens, outputTokens),
        };
      } catch (error) {
        if (attempt === maxAttempts || !isRetryableError(error)) {
          throw error;
        }

        const backoffMs = this.retryBaseDelayMs * attempt;
        await sleep(backoffMs);
      }
    }

    throw new Error(`Exhausted retries for ${this.modelId} on ${task.id}`);
  }
}
