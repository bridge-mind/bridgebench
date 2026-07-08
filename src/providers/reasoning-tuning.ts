/**
 * Shared reasoning/thinking tuning.
 *
 * Resolution order:
 *   1. The model's registry entry `tuning` (models.ts) when it fully
 *      specifies a reasoning configuration — the explicit source of truth.
 *   2. Synthetic model-ID variants (e.g. `foo:thinking`) mapped to the
 *      provider-specific request overrides needed to enable extended
 *      thinking.
 *
 * Used by bench runners' `tune*Request()` functions so this logic isn't
 * duplicated per bench.
 */

import { getModelEntry } from './models.js';

export interface ReasoningTuning {
  requestBodyOverrides: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
}

export function resolveReasoningTuning(modelId: string): ReasoningTuning | null {
  // Registry entry with a complete reasoning config wins.
  const tuning = getModelEntry(modelId)?.tuning;
  if (
    tuning?.requestBodyOverrides &&
    tuning.temperature !== undefined &&
    tuning.maxTokens !== undefined
  ) {
    return {
      requestBodyOverrides: tuning.requestBodyOverrides,
      temperature: tuning.temperature,
      maxTokens: tuning.maxTokens,
    };
  }

  // OpenRouter-routed Anthropic with max thinking
  if (
    modelId.startsWith('openrouter/anthropic/') &&
    modelId.endsWith(':thinking')
  ) {
    return {
      requestBodyOverrides: {
        reasoning: {
          max_tokens: 128_000,
          exclude: true, // keep the thinking trace out of the response body
        },
      },
      temperature: 1, // Anthropic rejects non-1 temperature with thinking
      maxTokens: 140_000, // must be strictly greater than the reasoning budget
    };
  }

  return null;
}
