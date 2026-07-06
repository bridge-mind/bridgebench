/**
 * Model pricing table.
 *
 * Prices are in USD per 1 million tokens.
 * Update these when providers change pricing or new models launch.
 *
 * Keys should match the model ID sent to the provider API
 * (i.e. the part *after* the provider prefix).
 */

interface ModelPricing {
  /** Cost per 1M input tokens in USD */
  input: number;
  /** Cost per 1M output tokens in USD */
  output: number;
}

// ---------------------------------------------------------------------------
// Pricing data — grouped by provider for readability
// ---------------------------------------------------------------------------

const PRICING: Record<string, ModelPricing> = {
  // ── Cursor (estimate — update when official pricing is published) ───
  'composer-2.5-fast': { input: 0, output: 0 },

  // ── Anthropic ────────────────────────────────────────────────────────
  'claude-opus-4-6-20250901':   { input: 15,    output: 75 },
  'claude-opus-4-6':            { input: 15,    output: 75 },
  'claude-opus-4-6-apr12':      { input: 15,    output: 75 },
  'claude-opus-4-5':            { input: 15,    output: 75 },
  'claude-sonnet-4-6-20250514': { input: 3,     output: 15 },
  'claude-sonnet-4-6':          { input: 3,     output: 15 },
  'claude-sonnet-4-5-20250514': { input: 3,     output: 15 },
  'claude-sonnet-4-5':          { input: 3,     output: 15 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4 },
  'claude-haiku-4-5':           { input: 0.80,  output: 4 },

  // ── OpenAI ───────────────────────────────────────────────────────────
  'gpt-5.5':                    { input: 5,     output: 30 },
  'gpt-5.4':                    { input: 2.50,  output: 10 },
  'gpt-5.4-mini':               { input: 0.40,  output: 1.60 },
  'gpt-5.4-nano':               { input: 0.20,  output: 1.25 },
  'gpt-5.3-codex':              { input: 2,     output: 8 },
  'gpt-5.2-codex':              { input: 1.50,  output: 6 },
  'gpt-4o':                     { input: 2.50,  output: 10 },
  'gpt-4o-mini':                { input: 0.15,  output: 0.60 },
  'o3':                         { input: 10,    output: 40 },
  'o3-mini':                    { input: 1.10,  output: 4.40 },
  'o4-mini':                    { input: 1.10,  output: 4.40 },

  // ── Google (Gemini) ──────────────────────────────────────────────────
  'gemini-3.1-pro-preview':     { input: 1.25,  output: 5 },
  'gemini-3-pro-preview':       { input: 1.25,  output: 5 },
  'gemini-2.5-pro-preview':     { input: 1.25,  output: 5 },
  'gemini-2.5-flash-preview':   { input: 0.15,  output: 0.60 },
  'gemini-2.0-flash':           { input: 0.10,  output: 0.40 },
  'gemma-4-31b-it':             { input: 0,     output: 0 },     // open-weight, free via AI Studio

  // ── xAI (Grok) ──────────────────────────────────────────────────────
  'grok-4.3':                   { input: 1.25,  output: 2.50 },
  'grok-4.20-reasoning':        { input: 2,     output: 6 },
  'grok-4.20':                  { input: 2,     output: 6 },
  'grok-4.2':                   { input: 3,     output: 15 },
  'grok-4.2-beta':              { input: 3,     output: 15 },
  'grok-3':                     { input: 3,     output: 15 },
  'grok-3-mini':                { input: 0.30,  output: 0.50 },

  // ── MiniMax ──────────────────────────────────────────────────────────
  'MiniMax-M2.7':               { input: 0.50,  output: 2 },
  'MiniMax-M2.7-highspeed':     { input: 0.50,  output: 2 },
  'minimax-m2.7':               { input: 0.50,  output: 2 },
  'MiniMax-M2.5':               { input: 0.50,  output: 2 },
  'minimax-m2.5':               { input: 0.50,  output: 2 },
  'MiniMax-Text-02':            { input: 0.50,  output: 2 },

  // ── Qwen (Alibaba) ──────────────────────────────────────────────────
  'qwen-max':                   { input: 1.60,  output: 6.40 },
  'qwen-max-latest':            { input: 1.60,  output: 6.40 },
  'qwen-plus':                  { input: 0.40,  output: 1.20 },
  'qwen-plus-latest':           { input: 0.40,  output: 1.20 },
  'qwen-turbo':                 { input: 0.06,  output: 0.24 },
  'qwen-turbo-latest':          { input: 0.06,  output: 0.24 },
  'qwen-long':                  { input: 0.14,  output: 0.28 },
  'qwen3-235b-a22b':            { input: 1.60,  output: 6.40 },
  'qwen3-32b':                  { input: 0.40,  output: 1.20 },
  'qwen3-14b':                  { input: 0.14,  output: 0.28 },
  'qwen-coder-plus':            { input: 0.80,  output: 3.20 },
  'qwen2.5-coder-32b-instruct': { input: 0.40,  output: 1.20 },
  'qwen/qwen3.6-plus-preview:free': { input: 0, output: 0 },
  'qwen/qwen3.6-plus':           { input: 1.60,  output: 6.40 },
  'qwen/qwen3.6-max-preview':    { input: 0,     output: 0 },
  'qwen/qwen3.7-max':            { input: 2.50,  output: 7.50 },

  // ── NVIDIA (Nemotron) ───────────────────────────────────────────────
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': { input: 0, output: 0 },
  'nvidia/nemotron-3-ultra-550b-a55b:free': { input: 0, output: 0 },
  'nvidia/nemotron-3-ultra-550b-a55b': { input: 0.50, output: 2.50 },

  // ── Xiaomi ──────────────────────────────────────────────────────────
  'xiaomi/mimo-v2.5':             { input: 0.40,  output: 2 },

  // ── OpenRouter ──────────────────────────────────────────────────────
  // Most OpenRouter models need no static pricing — OpenRouter returns actual
  // cost per request via the stream response, and the runner picks up costUsd
  // from StreamChunk. Static entries below act as a fallback for benches that
  // compute cost from token counts before the per-request cost is available.
  // Sakana Fugu Ultra: $5/M input, $30/M output (OpenRouter published rates).
  'sakana/fugu-ultra':          { input: 5,     output: 30 },
  // Claude Fable 5 via OpenRouter: $10/M input, $50/M output.
  'anthropic/claude-fable-5':   { input: 10,    output: 50 },

  // ── Zhipu (GLM) ─────────────────────────────────────────────────────
  // Z.ai's pricing page currently publishes GLM-5 rates but not a distinct
  // GLM-5.1 row. We apply the official GLM-5 pricing to GLM-5.1 until
  // Z.ai publishes separate pricing for that model.
  'glm-5.1':                    { input: 1,     output: 3.2 },
  'glm-5':                      { input: 1,     output: 3.2 },
  'glm-5-turbo':                { input: 0.15,  output: 0.60 },
  'glm-5v-turbo':               { input: 1.20,  output: 4 },
  'glm-4-plus':                 { input: 0.50,  output: 2 },
  'glm-4':                      { input: 0.15,  output: 0.60 },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Calculate cost from token counts and pricing table.
 * Returns 0 if the model is not in the table (no crash).
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const prices = PRICING[model];
  if (!prices) return 0;
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
}

/**
 * Check whether we have pricing data for a given model.
 */
export function hasPricing(model: string): boolean {
  return model in PRICING;
}
