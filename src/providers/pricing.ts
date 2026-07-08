/**
 * Model pricing — a thin adapter over the model registry.
 *
 * Pricing now lives on each registry entry (`ModelEntry.pricing`, USD per 1M
 * tokens) so a model's identity, routing, and economics stay in one place.
 * This module builds fast lookup tables from the registry and keeps a small
 * legacy table for models that predate it (historical journal replays).
 *
 * Lookup accepts either a full registry id ("anthropic/claude-opus-4-6"),
 * a registered alias, or the bare API model name ("claude-opus-4-6").
 */

import { MODEL_REGISTRY, resolveModelId } from './models.js';
import type { ModelPricing } from './models.js';

export type { ModelPricing } from './models.js';

// ---------------------------------------------------------------------------
// Legacy pricing — models NOT in the registry (kept so historical results
// and ad-hoc runs still cost correctly). Do not add new rows here; put
// pricing on the registry entry instead.
// ---------------------------------------------------------------------------

const LEGACY_PRICING: Record<string, ModelPricing> = {
  // ── Cursor (estimate — update when official pricing is published) ───
  'composer-2.5-fast': { input: 0, output: 0 },

  // ── Anthropic dated snapshots ────────────────────────────────────────
  'claude-opus-4-6-20250901':   { input: 15,    output: 75 },
  'claude-sonnet-4-6-20250514': { input: 3,     output: 15 },
  'claude-sonnet-4-5-20250514': { input: 3,     output: 15 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4 },

  // ── Qwen (Alibaba) commercial line ──────────────────────────────────
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

  // ── MiniMax ──────────────────────────────────────────────────────────
  'MiniMax-M2.7-highspeed':     { input: 0.50,  output: 2 },
  'MiniMax-Text-02':            { input: 0.50,  output: 2 },

  // ── OpenRouter one-offs ─────────────────────────────────────────────
  // Sakana Fugu Ultra: $5/M input, $30/M output (OpenRouter published rates).
  'sakana/fugu-ultra':          { input: 5,     output: 30 },
  'xiaomi/mimo-v2.5':           { input: 0.40,  output: 2 },
};

// ---------------------------------------------------------------------------
// Registry-derived lookup tables (built once at import)
// ---------------------------------------------------------------------------

/** Keyed by full registry id. */
const BY_ID = new Map<string, ModelPricing>();
/** Keyed by the model name sent to the provider API (post-prefix). */
const BY_API_MODEL = new Map<string, ModelPricing>();

for (const entry of Object.values(MODEL_REGISTRY)) {
  if (!entry.pricing) continue;
  BY_ID.set(entry.id, entry.pricing);
  const apiKey = entry.apiModel ?? entry.id.slice(entry.id.indexOf('/') + 1);
  if (!BY_API_MODEL.has(apiKey)) BY_API_MODEL.set(apiKey, entry.pricing);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve pricing for a registry id, alias, or bare API model name.
 * Returns null when unknown.
 */
export function getPricing(model: string): ModelPricing | null {
  return (
    BY_ID.get(model) ??
    BY_ID.get(resolveModelId(model)) ??
    BY_API_MODEL.get(model) ??
    LEGACY_PRICING[model] ??
    null
  );
}

/**
 * Calculate cost from token counts and pricing data.
 * Returns 0 if the model is not known (no crash).
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const prices = getPricing(model);
  if (!prices) return 0;
  return (inputTokens * prices.input + outputTokens * prices.output) / 1_000_000;
}

/**
 * Check whether we have pricing data for a given model.
 */
export function hasPricing(model: string): boolean {
  return getPricing(model) !== null;
}
