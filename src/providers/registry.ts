/**
 * Provider registry.
 *
 * Maps provider slugs (the prefix in "provider/model-id") to their
 * configuration, and creates the correct provider instance at runtime.
 *
 * To add a new provider:
 *   1. Add an entry to PROVIDERS below
 *   2. Add pricing data in pricing.ts
 *   3. That's it — the runner and CLI pick it up automatically
 */

import type { ProviderDefinition } from './types.js';
import type { BaseProvider } from './base.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { AnthropicProvider } from './anthropic.js';
import { MODEL_REGISTRY, resolveModelId } from './models.js';

// ---------------------------------------------------------------------------
// Provider definitions — the single source of truth
// ---------------------------------------------------------------------------

export const PROVIDERS: Record<string, ProviderDefinition> = {
  openai: {
    name: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    type: 'openai-compat',
    baseURL: 'https://api.openai.com/v1',
    maxTokensParam: 'max_completion_tokens',
    streamUsage: true,
  },

  anthropic: {
    name: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    type: 'anthropic',
  },

  google: {
    name: 'Google',
    envKey: 'GOOGLE_API_KEY',
    envAliases: ['GEMINI_API_KEY'],
    type: 'openai-compat',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    streamUsage: true,
  },

  'x-ai': {
    name: 'xAI',
    envKey: 'XAI_API_KEY',
    envAliases: ['X_AI_API_KEY'],
    type: 'openai-compat',
    baseURL: 'https://api.x.ai/v1',
    streamUsage: true,
  },

  minimax: {
    name: 'MiniMax',
    envKey: 'MINIMAX_API_KEY',
    type: 'anthropic',
    baseURL: 'https://api.minimax.io/anthropic',
  },

  'z-ai': {
    name: 'Z.ai',
    envKey: 'GLM_API_KEY',
    envAliases: ['ZHIPU_API_KEY', 'ZAI_API_KEY'],
    type: 'openai-compat',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    timeout: 360_000,
  },

  zhipu: {
    name: 'Zhipu (GLM)',
    envKey: 'GLM_API_KEY',
    envAliases: ['ZHIPU_API_KEY'],
    type: 'openai-compat',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    streamUsage: false,
    supportsStreaming: false,
  },

  qwen: {
    name: 'Qwen (Alibaba)',
    envKey: 'DASHSCOPE_API_KEY',
    type: 'openai-compat',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    streamUsage: true,
  },

  // ── Fallback / aggregator ────────────────────────────────────────────
  openrouter: {
    name: 'OpenRouter',
    kind: 'aggregator',
    envKey: 'OPENROUTER_API_KEY',
    type: 'openai-compat',
    baseURL: 'https://openrouter.ai/api/v1',
    streamUsage: true,
    timeout: 2_700_000,
    defaultHeaders: {
      'HTTP-Referer': 'https://bridgebench.ai',
      'X-Title': 'BridgeBench',
    },
  },
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split "provider/model-name" → { providerSlug, apiModel }.
 *
 * For OpenRouter the model part keeps the nested prefix:
 *   "openrouter/anthropic/claude-opus-4" → apiModel = "anthropic/claude-opus-4"
 */
export function parseModelId(fullModelId: string): {
  providerSlug: string;
  apiModel: string;
} {
  const slashIdx = fullModelId.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(
      `Invalid model ID "${fullModelId}". Expected format: provider/model-name\n` +
      `Available providers: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }

  const providerSlug = fullModelId.slice(0, slashIdx);
  const apiModel = fullModelId.slice(slashIdx + 1);

  if (!PROVIDERS[providerSlug]) {
    throw new Error(
      `Unknown provider "${providerSlug}" in model ID "${fullModelId}".\n` +
      `Available providers: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }

  return { providerSlug, apiModel };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a provider instance for the given model ID.
 *
 * Reads the API key from `apiKeys` (explicit overrides) or falls back
 * to the environment variable defined in the provider definition.
 */
export function createProvider(
  fullModelId: string,
  apiKeys?: Record<string, string>,
): { provider: BaseProvider; apiModel: string; providerSlug: string } {
  // Registered aliases (legacy prefixes like "xai/…") resolve to their
  // canonical id before parsing, so they stay runnable.
  const canonicalId = resolveModelId(fullModelId);
  const { providerSlug, apiModel: parsedApiModel } = parseModelId(canonicalId);
  const registryEntry = MODEL_REGISTRY[canonicalId];
  const apiModel = registryEntry?.apiModel ?? parsedApiModel;
  const def = PROVIDERS[providerSlug];
  const acceptedKeyNames = [providerSlug, def.envKey, ...(def.envAliases ?? [])];

  const apiKey =
    acceptedKeyNames.map((key) => apiKeys?.[key]).find(Boolean) ??
    [def.envKey, ...(def.envAliases ?? [])]
      .map((key) => process.env[key])
      .find(Boolean);

  if (!apiKey) {
    throw new Error(
      `No API key for ${def.name}. Set ${[def.envKey, ...(def.envAliases ?? [])].join(' or ')} in your environment ` +
      `or pass --api-key ${providerSlug}=<key>`,
    );
  }

  const config = { apiKey, timeout: def.timeout ?? 120_000 };
  const resolvedConfig = {
    ...config,
    baseURL: def.baseURL,
  };

  let provider: BaseProvider;

  if (def.type === 'anthropic') {
    provider = new AnthropicProvider(resolvedConfig);
  } else {
    provider = new OpenAICompatProvider(def.name, {
      ...resolvedConfig,
      baseURL: def.baseURL!,
      defaultHeaders: def.defaultHeaders,
      maxTokensParam: def.maxTokensParam,
      streamUsage: def.streamUsage,
      supportsStreaming: def.supportsStreaming,
    });
  }

  return { provider, apiModel, providerSlug };
}

// ---------------------------------------------------------------------------
// Introspection helpers (for CLI `providers` etc.)
// ---------------------------------------------------------------------------

export function listProviders(): Array<{
  slug: string;
  name: string;
  envKey: string;
  envAliases: string[];
  hasKey: boolean;
  configuredVia?: string;
}> {
  return Object.entries(PROVIDERS).map(([slug, def]) => {
    const configuredVia = [def.envKey, ...(def.envAliases ?? [])]
      .find((key) => !!process.env[key]);

    return {
      slug,
      name: def.name,
      envKey: def.envKey,
      envAliases: def.envAliases ?? [],
      hasKey: !!configuredVia,
      configuredVia,
    };
  });
}
