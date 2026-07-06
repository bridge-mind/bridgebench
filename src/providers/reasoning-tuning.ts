/**
 * Shared reasoning/thinking tuning.
 *
 * Maps synthetic model-ID variants (e.g. `foo:thinking`) to the
 * provider-specific request overrides needed to enable extended thinking.
 * Used by every bench runner's `tune*Request()` function so we don't
 * duplicate this logic per bench.
 *
 * Current supported variant: `<anthropic-model>:thinking` (via OpenRouter)
 * → OpenRouter `reasoning.max_tokens: 128000` (the documented ceiling)
 *   + temperature: 1 (required by Anthropic when thinking is enabled)
 *   + max_tokens: 140000 (must strictly exceed the reasoning budget)
 */

export interface ReasoningTuning {
  requestBodyOverrides: Record<string, unknown>;
  temperature: number;
  maxTokens: number;
}

export function resolveReasoningTuning(modelId: string): ReasoningTuning | null {
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
