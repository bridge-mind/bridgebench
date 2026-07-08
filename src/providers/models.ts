/**
 * Model registry — the single source of truth for every model BridgeBench
 * knows about: identity (ID, display name, slug), routing (provider, API
 * model override, aliases, variants), economics (pricing), capabilities
 * (reasoning, open weights), lifecycle (status, hidden), and per-model
 * request tuning.
 *
 * The CLI, runners, aggregators, publish scripts, bridgebench-ui, and
 * bridgebench-api all derive canonical model data from this registry —
 * directly (TypeScript imports) or via `bridgebench models export` (JSON).
 *
 * To add a new model:
 *   1. Add an entry below under its vendor section (see docs/model-registry.md)
 *   2. Include `pricing` (or `pricing: null` for aggregator-reported routes)
 *   3. Run `npm run models -- validate`
 *   4. That's it — CLI, runner, pricing, and exports pick it up automatically
 *
 * Invariants (enforced by `validateModelRegistry` + models.test.ts):
 *   - registry key === entry.id, and the id prefix is a known provider
 *     (or the entry is marked `runnable: false` for display-only models)
 *   - two entries may share a slug ONLY when linked via `variantOf`
 *   - aliases are globally unique and never shadow a real entry id
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a registry entry. */
export type ModelStatus = 'active' | 'preview' | 'deprecated' | 'retired';

/** Whether the model produces reasoning/thinking tokens. */
export type ReasoningSupport = 'none' | 'optional' | 'always';

export interface ModelPricing {
  /** Cost per 1M input tokens in USD */
  input: number;
  /** Cost per 1M output tokens in USD */
  output: number;
  /** ISO date the prices were last verified against the provider's page */
  asOf?: string;
  /** URL of the provider pricing page the numbers came from */
  source?: string;
}

/**
 * Per-model request shaping applied by runners. When present, this wins over
 * the family-wide pattern fallbacks in each suite's `tune*Request()`.
 */
export interface ModelRequestTuning {
  /** Extra provider-specific request body fields (e.g. reasoning config) */
  requestBodyOverrides?: Record<string, unknown>;
  /** Force a one-shot completion even when the provider supports streaming */
  forceNonStreaming?: boolean;
  /** Per-model completion ceiling; overrides the runner default when set */
  maxTokens?: number;
  /** Per-model sampling temperature (e.g. Anthropic thinking requires 1) */
  temperature?: number;
}

export interface ModelEntry {
  /** Full provider/model ID, e.g. "anthropic/claude-sonnet-4-6" */
  id: string;
  /** Canonical human-readable name, e.g. "Claude Sonnet 4.6" */
  displayName: string;
  /** Routing provider slug — must match PROVIDERS keys in registry.ts */
  provider: string;
  /**
   * The organization that created the model (not the route). For OpenRouter
   * entries this is the underlying lab, e.g. "anthropic" for
   * "openrouter/anthropic/claude-opus-4.7".
   */
  vendor: string;
  /** Coarse model family for grouping, e.g. "claude-opus", "gpt-5", "glm" */
  family?: string;
  /** URL-safe slug. Route/date variants of one model intentionally share it. */
  slug: string;
  /** Override the model name sent to the provider API (dated re-runs etc.) */
  apiModel?: string;
  /** Alternate ids that resolve to this entry (legacy prefixes, misspellings) */
  aliases?: string[];
  /**
   * When this entry is a re-run / alternate route / config variant of another
   * model, the id of the canonical entry. Required when two entries share a
   * slug. Variants must point at a canonical entry (no variant chains).
   */
  variantOf?: string;
  /** ISO release date, when known */
  releaseDate?: string;
  /** Context window in tokens, when known */
  contextWindow?: number;
  /** Max output tokens per completion, when known */
  maxOutputTokens?: number;
  /** Reasoning/thinking behavior, when known */
  reasoning?: ReasoningSupport;
  /** True for open-weight models */
  openWeights?: boolean;
  /** Lifecycle state. Defaults to "active" when omitted. */
  status?: ModelStatus;
  /** Suppress from leaderboards/UI without deleting result data */
  hidden?: boolean;
  /**
   * Set to false for display-only entries that cannot be run by the engine
   * (no provider adapter). Defaults to true.
   */
  runnable?: boolean;
  /**
   * Static pricing. `null` means "intentionally none" — the route reports
   * cost per request (OpenRouter) or the tier is free. Omitted means unknown
   * (validation warns so it gets filled in).
   */
  pricing?: ModelPricing | null;
  /** Per-model request tuning; wins over suite-level pattern fallbacks */
  tuning?: ModelRequestTuning;
  /** Free-form provenance / caveats surfaced by `models show` and exports */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Zod schemas — used by `models validate/export` and downstream consumers
// ---------------------------------------------------------------------------

export const ModelPricingSchema = z.object({
  input: z.number().min(0),
  output: z.number().min(0),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source: z.string().url().optional(),
});

export const ModelRequestTuningSchema = z.object({
  requestBodyOverrides: z.record(z.unknown()).optional(),
  forceNonStreaming: z.boolean().optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const ModelEntrySchema = z.object({
  id: z.string().min(3).includes('/'),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  vendor: z.string().min(1),
  family: z.string().min(1).optional(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case slugs only'),
  apiModel: z.string().min(1).optional(),
  aliases: z.array(z.string().min(3).includes('/')).optional(),
  variantOf: z.string().min(3).optional(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  reasoning: z.enum(['none', 'optional', 'always']).optional(),
  openWeights: z.boolean().optional(),
  status: z.enum(['active', 'preview', 'deprecated', 'retired']).optional(),
  hidden: z.boolean().optional(),
  runnable: z.boolean().optional(),
  pricing: ModelPricingSchema.nullable().optional(),
  tuning: ModelRequestTuningSchema.optional(),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Slug helpers (shared implementation — replaces duplicates across the codebase)
// ---------------------------------------------------------------------------

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** modelId → artifact slug ("openai/gpt-5.4" → "openai--gpt-5.4"). */
export function artifactSlug(modelId: string): string {
  return modelId
    .replace(/\//g, '--')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const MODEL_REGISTRY: Record<string, ModelEntry> = {
  // ── Anthropic ────────────────────────────────────────────────────────
  'anthropic/claude-opus-4-6': {
    id: 'anthropic/claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-6',
    reasoning: 'optional',
    pricing: { input: 15, output: 75 },
  },
  'anthropic/claude-opus-4-6-apr12': {
    id: 'anthropic/claude-opus-4-6-apr12',
    displayName: 'Claude Opus 4.6 (April 12)',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-6-april-12',
    apiModel: 'claude-opus-4-6',
    variantOf: 'anthropic/claude-opus-4-6',
    reasoning: 'optional',
    pricing: { input: 15, output: 75 },
    notes: 'Dated re-run of Claude Opus 4.6 (same underlying model).',
  },
  'anthropic/claude-opus-4-5': {
    id: 'anthropic/claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-5',
    reasoning: 'optional',
    pricing: { input: 15, output: 75 },
  },
  'anthropic/claude-sonnet-4-6': {
    id: 'anthropic/claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-sonnet',
    slug: 'claude-sonnet-4-6',
    reasoning: 'optional',
    pricing: { input: 3, output: 15 },
  },
  'anthropic/claude-sonnet-4-5': {
    id: 'anthropic/claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-sonnet',
    slug: 'claude-sonnet-4-5',
    reasoning: 'optional',
    pricing: { input: 3, output: 15 },
  },
  'anthropic/claude-haiku-4-5': {
    id: 'anthropic/claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    vendor: 'anthropic',
    family: 'claude-haiku',
    slug: 'claude-haiku-4-5',
    reasoning: 'optional',
    pricing: { input: 0.8, output: 4 },
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  'openai/gpt-5.5': {
    id: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-5',
    reasoning: 'optional',
    pricing: { input: 5, output: 30 },
  },
  'openai/gpt-5.4': {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-4',
    reasoning: 'optional',
    pricing: { input: 2.5, output: 10 },
  },
  'openai/gpt-5.4-mini': {
    id: 'openai/gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-4-mini',
    reasoning: 'optional',
    pricing: { input: 0.4, output: 1.6 },
  },
  'openai/gpt-5.4-nano': {
    id: 'openai/gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-4-nano',
    reasoning: 'optional',
    pricing: { input: 0.2, output: 1.25 },
  },
  'openai/gpt-5.3-codex': {
    id: 'openai/gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-codex',
    slug: 'gpt-5-3-codex',
    reasoning: 'optional',
    pricing: { input: 2, output: 8 },
  },
  'openai/gpt-5.2-codex': {
    id: 'openai/gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-codex',
    slug: 'gpt-5-2-codex',
    reasoning: 'optional',
    pricing: { input: 1.5, output: 6 },
  },
  'openai/gpt-4.1': {
    id: 'openai/gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-4',
    slug: 'gpt-4-1',
    reasoning: 'none',
    pricing: { input: 2, output: 8 },
  },
  'openai/gpt-4o': {
    id: 'openai/gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-4',
    slug: 'gpt-4o',
    reasoning: 'none',
    pricing: { input: 2.5, output: 10 },
  },
  'openai/gpt-4o-mini': {
    id: 'openai/gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    vendor: 'openai',
    family: 'gpt-4',
    slug: 'gpt-4o-mini',
    reasoning: 'none',
    pricing: { input: 0.15, output: 0.6 },
  },
  'openai/o3': {
    id: 'openai/o3',
    displayName: 'o3',
    provider: 'openai',
    vendor: 'openai',
    family: 'o-series',
    slug: 'o3',
    reasoning: 'always',
    pricing: { input: 10, output: 40 },
  },
  'openai/o3-mini': {
    id: 'openai/o3-mini',
    displayName: 'o3-mini',
    provider: 'openai',
    vendor: 'openai',
    family: 'o-series',
    slug: 'o3-mini',
    reasoning: 'always',
    pricing: { input: 1.1, output: 4.4 },
  },
  'openai/o4-mini': {
    id: 'openai/o4-mini',
    displayName: 'o4-mini',
    provider: 'openai',
    vendor: 'openai',
    family: 'o-series',
    slug: 'o4-mini',
    reasoning: 'always',
    pricing: { input: 1.1, output: 4.4 },
  },

  // ── Google (Gemini) ──────────────────────────────────────────────────
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-pro',
    slug: 'gemini-3-1-pro',
    status: 'preview',
    reasoning: 'always',
    pricing: { input: 1.25, output: 5 },
  },
  'google/gemini-3-pro-preview': {
    id: 'google/gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-pro',
    slug: 'gemini-3-pro',
    status: 'preview',
    reasoning: 'always',
    pricing: { input: 1.25, output: 5 },
  },
  'google/gemini-2.5-pro': {
    id: 'google/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-pro',
    slug: 'gemini-2-5-pro',
    reasoning: 'optional',
    pricing: { input: 1.25, output: 5 },
  },
  'google/gemini-2.5-pro-preview': {
    id: 'google/gemini-2.5-pro-preview',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-pro',
    slug: 'gemini-2-5-pro',
    variantOf: 'google/gemini-2.5-pro',
    status: 'preview',
    reasoning: 'optional',
    pricing: { input: 1.25, output: 5 },
    notes: 'Preview endpoint of Gemini 2.5 Pro; shares the GA slug.',
  },
  'google/gemini-2.5-flash-preview': {
    id: 'google/gemini-2.5-flash-preview',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-flash',
    slug: 'gemini-2-5-flash',
    status: 'preview',
    reasoning: 'optional',
    pricing: { input: 0.15, output: 0.6 },
  },
  'google/gemini-2.0-flash': {
    id: 'google/gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'google',
    vendor: 'google',
    family: 'gemini-flash',
    slug: 'gemini-2-0-flash',
    reasoning: 'none',
    pricing: { input: 0.1, output: 0.4 },
  },
  'google/gemma-4-31b-it': {
    id: 'google/gemma-4-31b-it',
    displayName: 'Gemma 4 31B',
    provider: 'google',
    vendor: 'google',
    family: 'gemma',
    slug: 'gemma-4-31b',
    reasoning: 'none',
    openWeights: true,
    pricing: { input: 0, output: 0 },
    notes: 'Open-weight; free via AI Studio.',
  },

  // ── xAI (Grok) ──────────────────────────────────────────────────────
  'x-ai/grok-4.3': {
    id: 'x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-3',
    reasoning: 'optional',
    pricing: { input: 1.25, output: 2.5 },
  },
  'x-ai/grok-4.20': {
    id: 'x-ai/grok-4.20',
    displayName: 'Grok 4.20 (Non-Reasoning)',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-20',
    reasoning: 'none',
    pricing: { input: 2, output: 6 },
  },
  'x-ai/grok-4.20-reasoning': {
    id: 'x-ai/grok-4.20-reasoning',
    displayName: 'Grok 4.20 Reasoning',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-20-reasoning',
    reasoning: 'always',
    pricing: { input: 2, output: 6 },
  },
  'x-ai/grok-4.2': {
    id: 'x-ai/grok-4.2',
    displayName: 'Grok 4.2',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-2',
    reasoning: 'optional',
    pricing: { input: 3, output: 15 },
  },
  'x-ai/grok-4.2-beta': {
    id: 'x-ai/grok-4.2-beta',
    displayName: 'Grok 4.2 Beta',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-2-beta',
    variantOf: 'x-ai/grok-4.2',
    status: 'preview',
    reasoning: 'optional',
    pricing: { input: 3, output: 15 },
  },
  'x-ai/grok-4': {
    id: 'x-ai/grok-4',
    displayName: 'Grok 4',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4',
    aliases: ['xai/grok-4'],
    reasoning: 'optional',
  },
  'x-ai/grok-3': {
    id: 'x-ai/grok-3',
    displayName: 'Grok 3',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-3',
    reasoning: 'none',
    pricing: { input: 3, output: 15 },
  },
  'x-ai/grok-3-mini': {
    id: 'x-ai/grok-3-mini',
    displayName: 'Grok 3 Mini',
    provider: 'x-ai',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-3-mini',
    reasoning: 'none',
    pricing: { input: 0.3, output: 0.5 },
  },

  // ── Z.ai (GLM) ──────────────────────────────────────────────────────
  'z-ai/glm-5.2': {
    id: 'z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5-2',
    reasoning: 'optional',
    pricing: { input: 1, output: 3.2 },
    notes: 'Z.ai publishes GLM-5 rates; GLM-5.2 uses them until distinct pricing ships.',
  },
  'z-ai/glm-5.1': {
    id: 'z-ai/glm-5.1',
    displayName: 'GLM 5.1',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5-1',
    reasoning: 'optional',
    pricing: { input: 1, output: 3.2 },
    notes: 'Z.ai publishes GLM-5 rates; GLM-5.1 uses them until distinct pricing ships.',
  },
  'z-ai/glm-5': {
    id: 'z-ai/glm-5',
    displayName: 'GLM 5',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5',
    reasoning: 'optional',
    pricing: { input: 1, output: 3.2 },
  },
  'z-ai/glm-5-turbo': {
    id: 'z-ai/glm-5-turbo',
    displayName: 'GLM 5 Turbo',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5-turbo',
    reasoning: 'optional',
    pricing: { input: 0.15, output: 0.6 },
  },
  'z-ai/glm-5v-turbo': {
    id: 'z-ai/glm-5v-turbo',
    displayName: 'GLM 5V Turbo',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5v-turbo',
    reasoning: 'optional',
    pricing: { input: 1.2, output: 4 },
  },
  'z-ai/glm-4-plus': {
    id: 'z-ai/glm-4-plus',
    displayName: 'GLM 4 Plus',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-4-plus',
    reasoning: 'none',
    pricing: { input: 0.5, output: 2 },
  },
  'z-ai/glm-4': {
    id: 'z-ai/glm-4',
    displayName: 'GLM 4',
    provider: 'z-ai',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-4',
    reasoning: 'none',
    pricing: { input: 0.15, output: 0.6 },
  },
  'zhipu/glm-5': {
    id: 'zhipu/glm-5',
    displayName: 'GLM 5',
    provider: 'zhipu',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5',
    variantOf: 'z-ai/glm-5',
    reasoning: 'optional',
    pricing: { input: 1, output: 3.2 },
    notes: 'Same model as z-ai/glm-5 routed via Zhipu bigmodel.cn.',
  },

  // ── MiniMax ──────────────────────────────────────────────────────────
  'minimax/MiniMax-M2.7': {
    id: 'minimax/MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    provider: 'minimax',
    vendor: 'minimax',
    family: 'minimax-m',
    slug: 'minimax-m2-7',
    reasoning: 'optional',
    pricing: { input: 0.5, output: 2 },
  },
  'minimax/MiniMax-M2.5': {
    id: 'minimax/MiniMax-M2.5',
    displayName: 'MiniMax M2.5',
    provider: 'minimax',
    vendor: 'minimax',
    family: 'minimax-m',
    slug: 'minimax-m2-5',
    reasoning: 'optional',
    pricing: { input: 0.5, output: 2 },
  },

  // ── Qwen (Alibaba) ──────────────────────────────────────────────────
  'qwen/qwen3-coder-480b': {
    id: 'qwen/qwen3-coder-480b',
    displayName: 'Qwen3 Coder 480B',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen-coder',
    slug: 'qwen3-coder-480b',
    aliases: ['alibaba/qwen3-coder-480b'],
    openWeights: true,
  },
  'qwen/qwen3.5-397b-a17b': {
    id: 'qwen/qwen3.5-397b-a17b',
    displayName: 'Qwen3.5 397B A17B',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen3-5-397b-a17b',
    reasoning: 'optional',
    openWeights: true,
  },
  'qwen/qwen3.5-plus-02-15': {
    id: 'qwen/qwen3.5-plus-02-15',
    displayName: 'Qwen3.5 Plus 2026-02-15',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen3-5-plus-02-15',
    reasoning: 'optional',
  },
  'qwen/qwen3.5-35b-a3b': {
    id: 'qwen/qwen3.5-35b-a3b',
    displayName: 'Qwen 3.5 35B-A3B',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen-3-5-35b-a3b',
    reasoning: 'optional',
    openWeights: true,
  },
  'qwen/qwen3.5-122b-a10b': {
    id: 'qwen/qwen3.5-122b-a10b',
    displayName: 'Qwen 3.5 122B-A10B',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen-3-5-122b-a10b',
    reasoning: 'optional',
    openWeights: true,
  },
  'qwen/qwen3.5-27b': {
    id: 'qwen/qwen3.5-27b',
    displayName: 'Qwen 3.5 27B',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen-3-5-27b',
    reasoning: 'optional',
    openWeights: true,
  },
  'qwen/qwen3.5-flash-02-23': {
    id: 'qwen/qwen3.5-flash-02-23',
    displayName: 'Qwen 3.5 Flash (02-23)',
    provider: 'qwen',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen-3-5-flash-02-23',
    reasoning: 'optional',
  },

  // ── DeepSeek ─────────────────────────────────────────────────────────
  'deepseek/deepseek-r1': {
    id: 'deepseek/deepseek-r1',
    displayName: 'DeepSeek R1',
    provider: 'deepseek',
    vendor: 'deepseek',
    family: 'deepseek-r',
    slug: 'deepseek-r1',
    reasoning: 'always',
    openWeights: true,
    runnable: false,
    notes: 'Display-only: no DeepSeek provider adapter yet. Route via OpenRouter to run.',
  },

  // ── Meta ─────────────────────────────────────────────────────────────
  'meta/llama-4-maverick': {
    id: 'meta/llama-4-maverick',
    displayName: 'Llama 4 Maverick',
    provider: 'meta',
    vendor: 'meta',
    family: 'llama',
    slug: 'llama-4-maverick',
    reasoning: 'none',
    openWeights: true,
    runnable: false,
    notes: 'Display-only: no Meta provider adapter. Route via OpenRouter to run.',
  },

  // ── OpenRouter proxied models ────────────────────────────────────────
  // Pricing is `null` for these routes by design: OpenRouter reports actual
  // cost per request in-stream (StreamChunk.costUsd). Static entries exist
  // only where a fallback is useful before per-request cost arrives.
  'openrouter/x-ai/grok-4.3': {
    id: 'openrouter/x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'openrouter',
    vendor: 'x-ai',
    family: 'grok',
    slug: 'grok-4-3',
    variantOf: 'x-ai/grok-4.3',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-opus-4.7': {
    id: 'openrouter/anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-7',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-opus-4.7:thinking': {
    id: 'openrouter/anthropic/claude-opus-4.7:thinking',
    displayName: 'Claude Opus 4.7 (Thinking)',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-7-thinking',
    apiModel: 'anthropic/claude-opus-4.7',
    variantOf: 'openrouter/anthropic/claude-opus-4.7',
    reasoning: 'always',
    hidden: true,
    pricing: null,
    tuning: {
      requestBodyOverrides: {
        reasoning: { max_tokens: 128_000, exclude: true },
      },
      temperature: 1, // Anthropic rejects non-1 temperature with thinking
      maxTokens: 140_000, // must strictly exceed the reasoning budget
    },
    notes: 'Max extended-thinking config of Opus 4.7 via OpenRouter.',
  },
  'openrouter/openai/gpt-5.5': {
    id: 'openrouter/openai/gpt-5.5',
    displayName: 'GPT-5.5 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-5-openrouter',
    variantOf: 'openai/gpt-5.5',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/openai/gpt-5.5-pro': {
    id: 'openrouter/openai/gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro (OpenRouter)',
    provider: 'openrouter',
    vendor: 'openai',
    family: 'gpt-5',
    slug: 'gpt-5-5-pro-openrouter',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-opus-4.8': {
    id: 'openrouter/anthropic/claude-opus-4.8',
    displayName: 'Claude Opus 4.8 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-8-openrouter',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-opus-4-6': {
    id: 'openrouter/anthropic/claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-opus',
    slug: 'claude-opus-4-6',
    variantOf: 'anthropic/claude-opus-4-6',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-sonnet-5': {
    id: 'openrouter/anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-sonnet',
    slug: 'claude-sonnet-5-openrouter',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/anthropic/claude-fable-5-july-1': {
    id: 'openrouter/anthropic/claude-fable-5-july-1',
    displayName: 'Claude Fable 5 July 1st',
    provider: 'openrouter',
    vendor: 'anthropic',
    family: 'claude-fable',
    slug: 'claude-fable-5-july-1st',
    apiModel: 'anthropic/claude-fable-5',
    reasoning: 'optional',
    pricing: { input: 10, output: 50 },
    tuning: {
      // Reasoning tokens count against max_tokens but are excluded from the
      // content; without capping/excluding, the budget burns on reasoning and
      // the HTML comes back empty or truncated.
      requestBodyOverrides: {
        reasoning: { effort: 'minimal', exclude: true },
      },
      maxTokens: 32_000,
    },
    notes: 'July 1st dated run of Claude Fable 5 via OpenRouter.',
  },
  'openrouter/z-ai/glm-5.2': {
    id: 'openrouter/z-ai/glm-5.2',
    displayName: 'GLM 5.2',
    provider: 'openrouter',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5-2',
    variantOf: 'z-ai/glm-5.2',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/z-ai/glm-5': {
    id: 'openrouter/z-ai/glm-5',
    displayName: 'GLM-5',
    provider: 'openrouter',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5',
    variantOf: 'z-ai/glm-5',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/z-ai/glm-5v-turbo': {
    id: 'openrouter/z-ai/glm-5v-turbo',
    displayName: 'GLM 5V Turbo',
    provider: 'openrouter',
    vendor: 'z-ai',
    family: 'glm',
    slug: 'glm-5v-turbo',
    variantOf: 'z-ai/glm-5v-turbo',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/xiaomi/mimo-v2-pro': {
    id: 'openrouter/xiaomi/mimo-v2-pro',
    displayName: 'MiMo-V2-Pro',
    provider: 'openrouter',
    vendor: 'xiaomi',
    family: 'mimo',
    slug: 'mimo-v2-pro',
    reasoning: 'always',
    pricing: null,
  },
  'openrouter/xiaomi/mimo-v2.5-pro': {
    id: 'openrouter/xiaomi/mimo-v2.5-pro',
    displayName: 'MiMo v2.5 Pro',
    provider: 'openrouter',
    vendor: 'xiaomi',
    family: 'mimo',
    slug: 'mimo-v2-5-pro',
    reasoning: 'always',
    pricing: null,
  },
  'openrouter/minimax/minimax-m2.7': {
    id: 'openrouter/minimax/minimax-m2.7',
    displayName: 'MiniMax M2.7',
    provider: 'openrouter',
    vendor: 'minimax',
    family: 'minimax-m',
    slug: 'minimax-m2-7',
    variantOf: 'minimax/MiniMax-M2.7',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/minimax/minimax-m3': {
    id: 'openrouter/minimax/minimax-m3',
    displayName: 'MiniMax M3',
    provider: 'openrouter',
    vendor: 'minimax',
    family: 'minimax-m',
    slug: 'minimax-m3',
    reasoning: 'optional',
    pricing: null,
    tuning: {
      // M3 reasons heavily by default — 14k+ reasoning tokens observed before
      // any content, so a 16k ceiling truncates (finish_reason=length) with
      // zero HTML emitted. Exclude the trace and give the artifact room.
      // Note: `reasoning.effort` is NOT sent — M3's route rejected it (500);
      // the model keeps its natural thinking depth under a raised ceiling.
      requestBodyOverrides: {
        reasoning: { exclude: true },
      },
      maxTokens: 40_000,
    },
  },
  'openrouter/google/gemini-3.1-pro-preview': {
    id: 'openrouter/google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'openrouter',
    vendor: 'google',
    family: 'gemini-pro',
    slug: 'gemini-3-1-pro',
    variantOf: 'google/gemini-3.1-pro-preview',
    status: 'preview',
    reasoning: 'always',
    pricing: null,
  },
  'openrouter/qwen/qwen3.6-plus-preview:free': {
    id: 'openrouter/qwen/qwen3.6-plus-preview:free',
    displayName: 'Qwen 3.6 Plus Preview (Free)',
    provider: 'openrouter',
    vendor: 'qwen',
    family: 'qwen3-6',
    slug: 'qwen-3-6-plus-preview-free',
    variantOf: 'openrouter/qwen/qwen3.6-plus',
    status: 'preview',
    reasoning: 'optional',
    pricing: { input: 0, output: 0 },
  },
  'openrouter/qwen/qwen3.6-plus': {
    id: 'openrouter/qwen/qwen3.6-plus',
    displayName: 'Qwen 3.6 Plus',
    provider: 'openrouter',
    vendor: 'qwen',
    family: 'qwen3-6',
    slug: 'qwen-3-6-plus',
    reasoning: 'optional',
    pricing: { input: 1.6, output: 6.4 },
  },
  'openrouter/qwen/qwen3.6-max-preview': {
    id: 'openrouter/qwen/qwen3.6-max-preview',
    displayName: 'Qwen 3.6 Max Preview',
    provider: 'openrouter',
    vendor: 'qwen',
    family: 'qwen3-6',
    slug: 'qwen-3-6-max-preview',
    status: 'preview',
    reasoning: 'optional',
    pricing: { input: 0, output: 0 },
  },
  'openrouter/qwen/qwen3.7-max': {
    id: 'openrouter/qwen/qwen3.7-max',
    displayName: 'Qwen 3.7 Max',
    provider: 'openrouter',
    vendor: 'qwen',
    family: 'qwen3-7',
    slug: 'qwen-3-7-max',
    reasoning: 'optional',
    pricing: { input: 2.5, output: 7.5 },
  },
  'openrouter/qwen/qwen3.5-plus-02-15': {
    id: 'openrouter/qwen/qwen3.5-plus-02-15',
    displayName: 'Qwen3.5 Plus 2026-02-15',
    provider: 'openrouter',
    vendor: 'qwen',
    family: 'qwen3-5',
    slug: 'qwen3-5-plus-02-15',
    variantOf: 'qwen/qwen3.5-plus-02-15',
    reasoning: 'optional',
    pricing: null,
  },
  'openrouter/moonshotai/kimi-k2.5': {
    id: 'openrouter/moonshotai/kimi-k2.5',
    displayName: 'Kimi K2.5',
    provider: 'openrouter',
    vendor: 'moonshotai',
    family: 'kimi-k2',
    slug: 'kimi-k2-5',
    reasoning: 'always',
    openWeights: true,
    pricing: null,
  },
  'openrouter/moonshotai/kimi-k2.6': {
    id: 'openrouter/moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    provider: 'openrouter',
    vendor: 'moonshotai',
    family: 'kimi-k2',
    slug: 'kimi-k2-6',
    reasoning: 'always',
    openWeights: true,
    pricing: null,
  },
  'openrouter/moonshotai/kimi-k2.7-code': {
    id: 'openrouter/moonshotai/kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    provider: 'openrouter',
    vendor: 'moonshotai',
    family: 'kimi-k2',
    slug: 'kimi-k2-7-code',
    reasoning: 'always',
    pricing: null,
  },
  'openrouter/google/gemma-4-31b-it': {
    id: 'openrouter/google/gemma-4-31b-it',
    displayName: 'Gemma 4 31B',
    provider: 'openrouter',
    vendor: 'google',
    family: 'gemma',
    slug: 'gemma-4-31b',
    variantOf: 'google/gemma-4-31b-it',
    reasoning: 'none',
    openWeights: true,
    pricing: null,
  },
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    id: 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    displayName: 'Nemotron 3 Nano Omni 30B-A3B Reasoning (Free)',
    provider: 'openrouter',
    vendor: 'nvidia',
    family: 'nemotron',
    slug: 'nemotron-3-nano-omni-30b-a3b-reasoning-free',
    reasoning: 'always',
    openWeights: true,
    pricing: { input: 0, output: 0 },
  },
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': {
    id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra 550B-A55B (Free)',
    provider: 'openrouter',
    vendor: 'nvidia',
    family: 'nemotron',
    slug: 'nemotron-3-ultra-550b-a55b-free',
    variantOf: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
    openWeights: true,
    pricing: { input: 0, output: 0 },
  },
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b': {
    id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
    displayName: 'Nemotron 3 Ultra 550B-A55B',
    provider: 'openrouter',
    vendor: 'nvidia',
    family: 'nemotron',
    slug: 'nemotron-3-ultra-550b-a55b',
    openWeights: true,
    pricing: { input: 0.5, output: 2.5 },
  },
};

// ---------------------------------------------------------------------------
// Alias index (derived)
// ---------------------------------------------------------------------------

const ALIAS_TO_ID: Record<string, string> = {};
for (const entry of Object.values(MODEL_REGISTRY)) {
  for (const alias of entry.aliases ?? []) {
    ALIAS_TO_ID[alias] = entry.id;
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a model id or alias to its canonical registry id.
 * Unknown ids pass through unchanged.
 */
export function resolveModelId(modelId: string): string {
  if (MODEL_REGISTRY[modelId]) return modelId;
  return ALIAS_TO_ID[modelId] ?? modelId;
}

/**
 * Get the full ModelEntry for a model ID (alias-aware), or undefined
 * if not in the registry.
 */
export function getModelEntry(modelId: string): ModelEntry | undefined {
  return MODEL_REGISTRY[resolveModelId(modelId)];
}

/**
 * Follow `variantOf` to the canonical entry for a model (alias-aware).
 * Returns the entry itself when it is already canonical.
 */
export function getCanonicalEntry(modelId: string): ModelEntry | undefined {
  const entry = getModelEntry(modelId);
  if (!entry) return undefined;
  return entry.variantOf ? MODEL_REGISTRY[entry.variantOf] ?? entry : entry;
}

/**
 * Auto-format a model ID into a human-readable display name.
 * Used as fallback when a model is not in the registry.
 *
 * "anthropic/claude-sonnet-4-6" → "Claude Sonnet 4 6"
 * "openrouter/z-ai/glm-5"      → "Glm 5"
 */
function autoDisplayName(modelId: string): string {
  const afterSlash = modelId.includes('/')
    ? modelId.slice(modelId.lastIndexOf('/') + 1)
    : modelId;
  return afterSlash
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get the canonical display name for a model.
 * Returns the registry value if present, otherwise auto-formats the ID.
 */
export function getDisplayName(modelId: string): string {
  return getModelEntry(modelId)?.displayName ?? autoDisplayName(modelId);
}

/**
 * Get the canonical URL slug for a model.
 * Returns the registry value if present, otherwise slugifies the display name.
 */
export function getModelSlug(modelId: string): string {
  return getModelEntry(modelId)?.slug ?? slugify(getDisplayName(modelId));
}

/**
 * Reverse-lookup: find a model entry by its URL slug.
 * When several entries share a slug (route variants), the canonical entry
 * (the one without `variantOf`) wins.
 */
export function getModelBySlug(slug: string): ModelEntry | undefined {
  const matches = Object.values(MODEL_REGISTRY).filter((e) => e.slug === slug);
  if (matches.length === 0) return undefined;
  return matches.find((e) => !e.variantOf) ?? matches[0];
}

export interface ListModelsFilter {
  provider?: string;
  vendor?: string;
  /** Include hidden entries (default false) */
  includeHidden?: boolean;
  /** Include retired entries (default true) */
  includeRetired?: boolean;
}

/** List registry entries with optional filtering, in stable (vendor, id) order. */
export function listModels(filter: ListModelsFilter = {}): ModelEntry[] {
  return Object.values(MODEL_REGISTRY)
    .filter((e) => (filter.provider ? e.provider === filter.provider : true))
    .filter((e) => (filter.vendor ? e.vendor === filter.vendor : true))
    .filter((e) => (filter.includeHidden ? true : !e.hidden))
    .filter((e) =>
      filter.includeRetired === false ? e.status !== 'retired' : true,
    )
    .sort((a, b) =>
      a.vendor === b.vendor
        ? a.id.localeCompare(b.id)
        : a.vendor.localeCompare(b.vendor),
    );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface RegistryValidationReport {
  errors: string[];
  warnings: string[];
}

/**
 * Check every registry invariant. `knownProviders` is passed in (rather than
 * imported from registry.ts) to keep this module dependency-free.
 */
export function validateModelRegistry(
  knownProviders: readonly string[],
): RegistryValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const providerSet = new Set(knownProviders);

  const entries = Object.entries(MODEL_REGISTRY);
  const idSet = new Set(entries.map(([, e]) => e.id));

  const seenAliases = new Map<string, string>();
  const bySlug = new Map<string, ModelEntry[]>();

  for (const [key, entry] of entries) {
    const label = entry.id;

    if (key !== entry.id) {
      errors.push(`${label}: registry key "${key}" !== entry.id "${entry.id}"`);
    }

    const parsed = ModelEntrySchema.safeParse(entry);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push(`${label}: ${issue.path.join('.')} — ${issue.message}`);
      }
    }

    const slashIdx = entry.id.indexOf('/');
    const prefix = slashIdx === -1 ? '' : entry.id.slice(0, slashIdx);
    const runnable = entry.runnable !== false;

    if (runnable) {
      if (!providerSet.has(prefix)) {
        errors.push(
          `${label}: id prefix "${prefix}" is not a known provider — ` +
            `add a provider adapter or mark the entry \`runnable: false\``,
        );
      }
      if (entry.provider !== prefix) {
        errors.push(
          `${label}: provider "${entry.provider}" does not match id prefix "${prefix}"`,
        );
      }
    } else if (providerSet.has(prefix)) {
      warnings.push(
        `${label}: marked runnable: false but "${prefix}" is a known provider`,
      );
    }

    for (const alias of entry.aliases ?? []) {
      if (idSet.has(alias)) {
        errors.push(`${label}: alias "${alias}" shadows a real registry id`);
      }
      const previous = seenAliases.get(alias);
      if (previous) {
        errors.push(`${label}: alias "${alias}" already claimed by ${previous}`);
      }
      seenAliases.set(alias, entry.id);
    }

    if (entry.variantOf) {
      const target = MODEL_REGISTRY[entry.variantOf];
      if (!target) {
        errors.push(`${label}: variantOf "${entry.variantOf}" does not exist`);
      } else if (target.variantOf) {
        errors.push(
          `${label}: variantOf "${entry.variantOf}" is itself a variant — ` +
            `variants must point at a canonical entry`,
        );
      }
      if (entry.variantOf === entry.id) {
        errors.push(`${label}: variantOf points at itself`);
      }
    }

    if (
      runnable &&
      entry.pricing === undefined &&
      entry.status !== 'retired'
    ) {
      warnings.push(
        `${label}: no pricing — cost falls back to route-reported or 0 ` +
          `(set pricing, or pricing: null for aggregator-reported routes)`,
      );
    }

    const group = bySlug.get(entry.slug) ?? [];
    group.push(entry);
    bySlug.set(entry.slug, group);
  }

  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    const canonicals = group.filter((e) => !e.variantOf);
    if (canonicals.length !== 1) {
      errors.push(
        `slug "${slug}" shared by [${group.map((e) => e.id).join(', ')}] — ` +
          `exactly one entry may be canonical (found ${canonicals.length}); ` +
          `link the others via variantOf`,
      );
      continue;
    }
    const canonicalId = canonicals[0].id;
    for (const entry of group) {
      if (entry.variantOf && entry.variantOf !== canonicalId) {
        errors.push(
          `slug "${slug}": ${entry.id} is variantOf "${entry.variantOf}" ` +
            `but the slug's canonical entry is "${canonicalId}"`,
        );
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Export — the JSON contract consumed by bridgebench-ui / bridgebench-api
// ---------------------------------------------------------------------------

export interface RegistryExportProvider {
  slug: string;
  name: string;
  type: string;
  kind: 'vendor' | 'aggregator';
  baseURL?: string;
}

export interface RegistryExportMeta {
  engineVersion: string;
  season: number;
  providers: RegistryExportProvider[];
}

/** A ModelEntry flattened for export: defaults resolved, tuning stripped. */
export interface ExportedModel {
  id: string;
  displayName: string;
  provider: string;
  vendor: string;
  family: string | null;
  slug: string;
  artifactSlug: string;
  apiModel: string | null;
  aliases: string[];
  canonicalId: string;
  releaseDate: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  reasoning: ReasoningSupport | null;
  openWeights: boolean | null;
  status: ModelStatus;
  hidden: boolean;
  runnable: boolean;
  pricing: ModelPricing | null;
  notes: string | null;
}

export interface RegistryExport {
  schemaVersion: 1;
  engine: { version: string };
  season: number;
  providers: RegistryExportProvider[];
  models: ExportedModel[];
}

export const RegistryExportSchema = z.object({
  schemaVersion: z.literal(1),
  engine: z.object({ version: z.string().min(1) }),
  season: z.number().int().positive(),
  providers: z.array(
    z.object({
      slug: z.string().min(1),
      name: z.string().min(1),
      type: z.string().min(1),
      kind: z.enum(['vendor', 'aggregator']),
      baseURL: z.string().optional(),
    }),
  ),
  models: z.array(
    z.object({
      id: z.string().min(3),
      displayName: z.string().min(1),
      provider: z.string().min(1),
      vendor: z.string().min(1),
      family: z.string().nullable(),
      slug: z.string().min(1),
      artifactSlug: z.string().min(1),
      apiModel: z.string().nullable(),
      aliases: z.array(z.string()),
      canonicalId: z.string().min(3),
      releaseDate: z.string().nullable(),
      contextWindow: z.number().nullable(),
      maxOutputTokens: z.number().nullable(),
      reasoning: z.enum(['none', 'optional', 'always']).nullable(),
      openWeights: z.boolean().nullable(),
      status: z.enum(['active', 'preview', 'deprecated', 'retired']),
      hidden: z.boolean(),
      runnable: z.boolean(),
      pricing: ModelPricingSchema.nullable(),
      notes: z.string().nullable(),
    }),
  ),
});

/**
 * Build the deterministic JSON export (stable sort, defaults resolved,
 * harness-internal tuning stripped). No timestamps — re-running against an
 * unchanged registry produces a byte-identical document.
 */
export function buildRegistryExport(meta: RegistryExportMeta): RegistryExport {
  const models: ExportedModel[] = listModels({ includeHidden: true }).map(
    (entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      provider: entry.provider,
      vendor: entry.vendor,
      family: entry.family ?? null,
      slug: entry.slug,
      artifactSlug: artifactSlug(entry.id),
      apiModel: entry.apiModel ?? null,
      aliases: entry.aliases ?? [],
      canonicalId: entry.variantOf ?? entry.id,
      releaseDate: entry.releaseDate ?? null,
      contextWindow: entry.contextWindow ?? null,
      maxOutputTokens: entry.maxOutputTokens ?? null,
      reasoning: entry.reasoning ?? null,
      openWeights: entry.openWeights ?? null,
      status: entry.status ?? 'active',
      hidden: entry.hidden ?? false,
      runnable: entry.runnable !== false,
      pricing: entry.pricing ?? null,
      notes: entry.notes ?? null,
    }),
  );

  return {
    schemaVersion: 1,
    engine: { version: meta.engineVersion },
    season: meta.season,
    providers: [...meta.providers].sort((a, b) => a.slug.localeCompare(b.slug)),
    models,
  };
}
