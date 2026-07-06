/**
 * Model registry — single source of truth for model IDs, display names, and slugs.
 *
 * Every model that BridgeBench can evaluate should have an entry here.
 * The CLI, runners, aggregators, and bridgebench-ui all derive canonical
 * display names and URL slugs from this registry.
 *
 * To add a new model:
 *   1. Add an entry below with its full modelId, displayName, provider, and slug
 *   2. Add pricing data in pricing.ts
 *   3. That's it — everything else picks it up automatically
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Full provider/model ID, e.g. "anthropic/claude-sonnet-4-6" */
  id: string;
  /** Canonical human-readable name, e.g. "Claude Sonnet 4.6" */
  displayName: string;
  /** Provider slug matching PROVIDERS keys in registry.ts */
  provider: string;
  /** URL-safe slug derived from displayName, e.g. "claude-sonnet-4-6" */
  slug: string;
  /** Override the model name sent to the provider API (for dated re-runs that share the same underlying model) */
  apiModel?: string;
}

// ---------------------------------------------------------------------------
// Slug helper (shared implementation — replaces duplicates across the codebase)
// ---------------------------------------------------------------------------

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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
    slug: 'claude-opus-4-6',
  },
  'anthropic/claude-opus-4-6-apr12': {
    id: 'anthropic/claude-opus-4-6-apr12',
    displayName: 'Claude Opus 4.6 (April 12)',
    provider: 'anthropic',
    slug: 'claude-opus-4-6-april-12',
    apiModel: 'claude-opus-4-6',
  },
  'anthropic/claude-opus-4-5': {
    id: 'anthropic/claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    provider: 'anthropic',
    slug: 'claude-opus-4-5',
  },
  'anthropic/claude-sonnet-4-6': {
    id: 'anthropic/claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    slug: 'claude-sonnet-4-6',
  },
  'anthropic/claude-sonnet-4-5': {
    id: 'anthropic/claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    slug: 'claude-sonnet-4-5',
  },
  'anthropic/claude-haiku-4-5': {
    id: 'anthropic/claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    provider: 'anthropic',
    slug: 'claude-haiku-4-5',
  },

  // ── OpenAI ───────────────────────────────────────────────────────────
  'openai/gpt-5.5': {
    id: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    slug: 'gpt-5-5',
  },
  'openai/gpt-5.4': {
    id: 'openai/gpt-5.4',
    displayName: 'GPT-5.4',
    provider: 'openai',
    slug: 'gpt-5-4',
  },
  'openai/gpt-5.4-mini': {
    id: 'openai/gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    provider: 'openai',
    slug: 'gpt-5-4-mini',
  },
  'openai/gpt-5.4-nano': {
    id: 'openai/gpt-5.4-nano',
    displayName: 'GPT-5.4 Nano',
    provider: 'openai',
    slug: 'gpt-5-4-nano',
  },
  'openai/gpt-5.3-codex': {
    id: 'openai/gpt-5.3-codex',
    displayName: 'GPT-5.3 Codex',
    provider: 'openai',
    slug: 'gpt-5-3-codex',
  },
  'openai/gpt-5.2-codex': {
    id: 'openai/gpt-5.2-codex',
    displayName: 'GPT-5.2 Codex',
    provider: 'openai',
    slug: 'gpt-5-2-codex',
  },
  'openai/gpt-4.1': {
    id: 'openai/gpt-4.1',
    displayName: 'GPT-4.1',
    provider: 'openai',
    slug: 'gpt-4-1',
  },
  'openai/gpt-4o': {
    id: 'openai/gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    slug: 'gpt-4o',
  },
  'openai/gpt-4o-mini': {
    id: 'openai/gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    slug: 'gpt-4o-mini',
  },
  'openai/o3': {
    id: 'openai/o3',
    displayName: 'o3',
    provider: 'openai',
    slug: 'o3',
  },
  'openai/o3-mini': {
    id: 'openai/o3-mini',
    displayName: 'o3-mini',
    provider: 'openai',
    slug: 'o3-mini',
  },
  'openai/o4-mini': {
    id: 'openai/o4-mini',
    displayName: 'o4-mini',
    provider: 'openai',
    slug: 'o4-mini',
  },

  // ── Google (Gemini) ──────────────────────────────────────────────────
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'google',
    slug: 'gemini-3-1-pro',
  },
  'google/gemini-3-pro-preview': {
    id: 'google/gemini-3-pro-preview',
    displayName: 'Gemini 3 Pro',
    provider: 'google',
    slug: 'gemini-3-pro',
  },
  'google/gemini-2.5-pro-preview': {
    id: 'google/gemini-2.5-pro-preview',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    slug: 'gemini-2-5-pro',
  },
  'google/gemini-2.5-pro': {
    id: 'google/gemini-2.5-pro',
    displayName: 'Gemini 2.5 Pro',
    provider: 'google',
    slug: 'gemini-2-5-pro',
  },
  'google/gemini-2.5-flash-preview': {
    id: 'google/gemini-2.5-flash-preview',
    displayName: 'Gemini 2.5 Flash',
    provider: 'google',
    slug: 'gemini-2-5-flash',
  },
  'google/gemini-2.0-flash': {
    id: 'google/gemini-2.0-flash',
    displayName: 'Gemini 2.0 Flash',
    provider: 'google',
    slug: 'gemini-2-0-flash',
  },
  'google/gemma-4-31b-it': {
    id: 'google/gemma-4-31b-it',
    displayName: 'Gemma 4 31B',
    provider: 'google',
    slug: 'gemma-4-31b',
  },

  // ── xAI (Grok) ──────────────────────────────────────────────────────
  'x-ai/grok-4.3': {
    id: 'x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'x-ai',
    slug: 'grok-4-3',
  },
  'x-ai/grok-4.20': {
    id: 'x-ai/grok-4.20',
    displayName: 'Grok 4.20 (Non-Reasoning)',
    provider: 'x-ai',
    slug: 'grok-4-20',
  },
  'x-ai/grok-4.20-reasoning': {
    id: 'x-ai/grok-4.20-reasoning',
    displayName: 'Grok 4.20 Reasoning',
    provider: 'x-ai',
    slug: 'grok-4-20-reasoning',
  },
  'x-ai/grok-4.2': {
    id: 'x-ai/grok-4.2',
    displayName: 'Grok 4.2',
    provider: 'x-ai',
    slug: 'grok-4-2',
  },
  'x-ai/grok-4.2-beta': {
    id: 'x-ai/grok-4.2-beta',
    displayName: 'Grok 4.2 Beta',
    provider: 'x-ai',
    slug: 'grok-4-2-beta',
  },
  'x-ai/grok-4': {
    id: 'x-ai/grok-4',
    displayName: 'Grok 4',
    provider: 'x-ai',
    slug: 'grok-4',
  },
  'x-ai/grok-3': {
    id: 'x-ai/grok-3',
    displayName: 'Grok 3',
    provider: 'x-ai',
    slug: 'grok-3',
  },
  'x-ai/grok-3-mini': {
    id: 'x-ai/grok-3-mini',
    displayName: 'Grok 3 Mini',
    provider: 'x-ai',
    slug: 'grok-3-mini',
  },
  'xai/grok-4': {
    id: 'xai/grok-4',
    displayName: 'Grok 4',
    provider: 'x-ai',
    slug: 'grok-4',
  },

  // ── Z.ai (GLM) ──────────────────────────────────────────────────────
  'z-ai/glm-5.1': {
    id: 'z-ai/glm-5.1',
    displayName: 'GLM 5.1',
    provider: 'z-ai',
    slug: 'glm-5-1',
  },
  'z-ai/glm-5': {
    id: 'z-ai/glm-5',
    displayName: 'GLM 5',
    provider: 'z-ai',
    slug: 'glm-5',
  },
  'z-ai/glm-5-turbo': {
    id: 'z-ai/glm-5-turbo',
    displayName: 'GLM 5 Turbo',
    provider: 'z-ai',
    slug: 'glm-5-turbo',
  },
  'z-ai/glm-5v-turbo': {
    id: 'z-ai/glm-5v-turbo',
    displayName: 'GLM 5V Turbo',
    provider: 'z-ai',
    slug: 'glm-5v-turbo',
  },
  'z-ai/glm-4-plus': {
    id: 'z-ai/glm-4-plus',
    displayName: 'GLM 4 Plus',
    provider: 'z-ai',
    slug: 'glm-4-plus',
  },
  'z-ai/glm-4': {
    id: 'z-ai/glm-4',
    displayName: 'GLM 4',
    provider: 'z-ai',
    slug: 'glm-4',
  },
  'zhipu/glm-5': {
    id: 'zhipu/glm-5',
    displayName: 'GLM 5',
    provider: 'zhipu',
    slug: 'glm-5',
  },

  // ── MiniMax ──────────────────────────────────────────────────────────
  'minimax/MiniMax-M2.7': {
    id: 'minimax/MiniMax-M2.7',
    displayName: 'MiniMax M2.7',
    provider: 'minimax',
    slug: 'minimax-m2-7',
  },
  'minimax/MiniMax-M2.5': {
    id: 'minimax/MiniMax-M2.5',
    displayName: 'MiniMax M2.5',
    provider: 'minimax',
    slug: 'minimax-m2-5',
  },

  // ── Qwen (Alibaba) ──────────────────────────────────────────────────
  'alibaba/qwen3-coder-480b': {
    id: 'alibaba/qwen3-coder-480b',
    displayName: 'Qwen3 Coder 480B',
    provider: 'qwen',
    slug: 'qwen3-coder-480b',
  },
  'qwen/qwen3.5-397b-a17b': {
    id: 'qwen/qwen3.5-397b-a17b',
    displayName: 'Qwen3.5 397B A17B',
    provider: 'qwen',
    slug: 'qwen3-5-397b-a17b',
  },
  'qwen/qwen3.5-plus-02-15': {
    id: 'qwen/qwen3.5-plus-02-15',
    displayName: 'Qwen3.5 Plus 2026-02-15',
    provider: 'qwen',
    slug: 'qwen3-5-plus-02-15',
  },
  'qwen/qwen3.5-35b-a3b': {
    id: 'qwen/qwen3.5-35b-a3b',
    displayName: 'Qwen 3.5 35B-A3B',
    provider: 'qwen',
    slug: 'qwen-3-5-35b-a3b',
  },
  'qwen/qwen3.5-122b-a10b': {
    id: 'qwen/qwen3.5-122b-a10b',
    displayName: 'Qwen 3.5 122B-A10B',
    provider: 'qwen',
    slug: 'qwen-3-5-122b-a10b',
  },
  'qwen/qwen3.5-27b': {
    id: 'qwen/qwen3.5-27b',
    displayName: 'Qwen 3.5 27B',
    provider: 'qwen',
    slug: 'qwen-3-5-27b',
  },
  'qwen/qwen3.5-flash-02-23': {
    id: 'qwen/qwen3.5-flash-02-23',
    displayName: 'Qwen 3.5 Flash (02-23)',
    provider: 'qwen',
    slug: 'qwen-3-5-flash-02-23',
  },

  // ── DeepSeek ─────────────────────────────────────────────────────────
  'deepseek/deepseek-r1': {
    id: 'deepseek/deepseek-r1',
    displayName: 'DeepSeek R1',
    provider: 'deepseek',
    slug: 'deepseek-r1',
  },

  // ── Meta ─────────────────────────────────────────────────────────────
  'meta/llama-4-maverick': {
    id: 'meta/llama-4-maverick',
    displayName: 'Llama 4 Maverick',
    provider: 'meta',
    slug: 'llama-4-maverick',
  },

  // ── OpenRouter proxied models ────────────────────────────────────────
  'openrouter/x-ai/grok-4.3': {
    id: 'openrouter/x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    provider: 'openrouter',
    slug: 'grok-4-3',
  },
  'openrouter/anthropic/claude-opus-4.7': {
    id: 'openrouter/anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    provider: 'openrouter',
    slug: 'claude-opus-4-7',
  },
  'openrouter/anthropic/claude-opus-4.7:thinking': {
    id: 'openrouter/anthropic/claude-opus-4.7:thinking',
    displayName: 'Claude Opus 4.7 (Thinking)',
    provider: 'openrouter',
    slug: 'claude-opus-4-7-thinking',
    apiModel: 'anthropic/claude-opus-4.7',
  },
  'openrouter/openai/gpt-5.5': {
    id: 'openrouter/openai/gpt-5.5',
    displayName: 'GPT-5.5 (OpenRouter)',
    provider: 'openrouter',
    slug: 'gpt-5-5-openrouter',
  },
  'openrouter/openai/gpt-5.5-pro': {
    id: 'openrouter/openai/gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro (OpenRouter)',
    provider: 'openrouter',
    slug: 'gpt-5-5-pro-openrouter',
  },
  'openrouter/anthropic/claude-opus-4.8': {
    id: 'openrouter/anthropic/claude-opus-4.8',
    displayName: 'Claude Opus 4.8 (OpenRouter)',
    provider: 'openrouter',
    slug: 'claude-opus-4-8-openrouter',
  },
  'openrouter/anthropic/claude-opus-4-6': {
    id: 'openrouter/anthropic/claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    provider: 'openrouter',
    slug: 'claude-opus-4-6',
  },
  'openrouter/anthropic/claude-sonnet-5': {
    id: 'openrouter/anthropic/claude-sonnet-5',
    displayName: 'Claude Sonnet 5 (OpenRouter)',
    provider: 'openrouter',
    slug: 'claude-sonnet-5-openrouter',
  },
  'openrouter/anthropic/claude-fable-5-july-1': {
    id: 'openrouter/anthropic/claude-fable-5-july-1',
    displayName: 'Claude Fable 5 July 1st',
    provider: 'openrouter',
    slug: 'claude-fable-5-july-1st',
    apiModel: 'anthropic/claude-fable-5',
  },
  'openrouter/z-ai/glm-5': {
    id: 'openrouter/z-ai/glm-5',
    displayName: 'GLM-5',
    provider: 'openrouter',
    slug: 'glm-5',
  },
  'openrouter/z-ai/glm-5v-turbo': {
    id: 'openrouter/z-ai/glm-5v-turbo',
    displayName: 'GLM 5V Turbo',
    provider: 'openrouter',
    slug: 'glm-5v-turbo',
  },
  'openrouter/xiaomi/mimo-v2-pro': {
    id: 'openrouter/xiaomi/mimo-v2-pro',
    displayName: 'MiMo-V2-Pro',
    provider: 'openrouter',
    slug: 'mimo-v2-pro',
  },
  'openrouter/xiaomi/mimo-v2.5-pro': {
    id: 'openrouter/xiaomi/mimo-v2.5-pro',
    displayName: 'MiMo v2.5 Pro',
    provider: 'openrouter',
    slug: 'mimo-v2-5-pro',
  },
  'openrouter/minimax/minimax-m2.7': {
    id: 'openrouter/minimax/minimax-m2.7',
    displayName: 'MiniMax M2.7',
    provider: 'openrouter',
    slug: 'minimax-m2-7',
  },
  'openrouter/minimax/minimax-m3': {
    id: 'openrouter/minimax/minimax-m3',
    displayName: 'MiniMax M3',
    provider: 'openrouter',
    slug: 'minimax-m3',
  },
  'openrouter/google/gemini-3.1-pro-preview': {
    id: 'openrouter/google/gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    provider: 'openrouter',
    slug: 'gemini-3-1-pro',
  },
  'openrouter/qwen/qwen3.6-plus-preview:free': {
    id: 'openrouter/qwen/qwen3.6-plus-preview:free',
    displayName: 'Qwen 3.6 Plus Preview (Free)',
    provider: 'openrouter',
    slug: 'qwen-3-6-plus-preview-free',
  },
  'openrouter/qwen/qwen3.6-plus': {
    id: 'openrouter/qwen/qwen3.6-plus',
    displayName: 'Qwen 3.6 Plus',
    provider: 'openrouter',
    slug: 'qwen-3-6-plus',
  },
  'openrouter/qwen/qwen3.6-max-preview': {
    id: 'openrouter/qwen/qwen3.6-max-preview',
    displayName: 'Qwen 3.6 Max Preview',
    provider: 'openrouter',
    slug: 'qwen-3-6-max-preview',
  },
  'openrouter/qwen/qwen3.7-max': {
    id: 'openrouter/qwen/qwen3.7-max',
    displayName: 'Qwen 3.7 Max',
    provider: 'openrouter',
    slug: 'qwen-3-7-max',
  },
  'openrouter/qwen/qwen3.5-plus-02-15': {
    id: 'openrouter/qwen/qwen3.5-plus-02-15',
    displayName: 'Qwen3.5 Plus 2026-02-15',
    provider: 'openrouter',
    slug: 'qwen3-5-plus-02-15',
  },
  'openrouter/moonshotai/kimi-k2.5': {
    id: 'openrouter/moonshotai/kimi-k2.5',
    displayName: 'Kimi K2.5',
    provider: 'openrouter',
    slug: 'kimi-k2-5',
  },
  'openrouter/moonshotai/kimi-k2.6': {
    id: 'openrouter/moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    provider: 'openrouter',
    slug: 'kimi-k2-6',
  },
  'openrouter/moonshotai/kimi-k2.7-code': {
    id: 'openrouter/moonshotai/kimi-k2.7-code',
    displayName: 'Kimi K2.7 Code',
    provider: 'openrouter',
    slug: 'kimi-k2-7-code',
  },
  'openrouter/google/gemma-4-31b-it': {
    id: 'openrouter/google/gemma-4-31b-it',
    displayName: 'Gemma 4 31B',
    provider: 'openrouter',
    slug: 'gemma-4-31b',
  },
  'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': {
    id: 'openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    displayName: 'Nemotron 3 Nano Omni 30B-A3B Reasoning (Free)',
    provider: 'openrouter',
    slug: 'nemotron-3-nano-omni-30b-a3b-reasoning-free',
  },
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free': {
    id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    displayName: 'Nemotron 3 Ultra 550B-A55B (Free)',
    provider: 'openrouter',
    slug: 'nemotron-3-ultra-550b-a55b-free',
  },
  'openrouter/nvidia/nemotron-3-ultra-550b-a55b': {
    id: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b',
    displayName: 'Nemotron 3 Ultra 550B-A55B',
    provider: 'openrouter',
    slug: 'nemotron-3-ultra-550b-a55b',
  },
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

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
  return MODEL_REGISTRY[modelId]?.displayName ?? autoDisplayName(modelId);
}

/**
 * Get the canonical URL slug for a model.
 * Returns the registry value if present, otherwise slugifies the display name.
 */
export function getModelSlug(modelId: string): string {
  return MODEL_REGISTRY[modelId]?.slug ?? slugify(getDisplayName(modelId));
}

/**
 * Reverse-lookup: find a model entry by its URL slug.
 * Returns the first match or undefined.
 */
export function getModelBySlug(slug: string): ModelEntry | undefined {
  return Object.values(MODEL_REGISTRY).find((entry) => entry.slug === slug);
}

/**
 * Get the full ModelEntry for a model ID, or undefined if not in the registry.
 */
export function getModelEntry(modelId: string): ModelEntry | undefined {
  return MODEL_REGISTRY[modelId];
}
