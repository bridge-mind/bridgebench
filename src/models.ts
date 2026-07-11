import type { ModelRegistryEntry } from './types.js';

// Expert-depth tasks: multi-part deliverables plus hidden reasoning need real
// headroom, and judges now digest ~10k-token payloads before writing verdicts.
const competitorRequest = {
  maxTokens: 16_384,
  temperature: 0,
  reasoningEffort: 'high' as const,
  excludeReasoning: true,
  timeoutMs: 300_000,
};

const judgeRequest = {
  maxTokens: 8_192,
  temperature: 0,
  reasoningEffort: 'medium' as const,
  excludeReasoning: true,
  timeoutMs: 240_000,
};

export const MODEL_REGISTRY: Record<string, ModelRegistryEntry> = {
  'openai/gpt-5.6-sol': {
    id: 'openai/gpt-5.6-sol',
    canonicalSlug: 'openai/gpt-5.6-sol-20260709',
    displayName: 'GPT-5.6 Sol',
    vendor: 'openai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'openai/gpt-5.6-terra': {
    id: 'openai/gpt-5.6-terra',
    canonicalSlug: 'openai/gpt-5.6-terra-20260709',
    displayName: 'GPT-5.6 Terra',
    vendor: 'openai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'openai/gpt-5.6-luna': {
    id: 'openai/gpt-5.6-luna',
    canonicalSlug: 'openai/gpt-5.6-luna-20260709',
    displayName: 'GPT-5.6 Luna',
    vendor: 'openai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'anthropic/claude-fable-5': {
    id: 'anthropic/claude-fable-5',
    canonicalSlug: 'anthropic/claude-5-fable-20260609',
    displayName: 'Claude Fable 5',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'anthropic/claude-opus-4.8': {
    id: 'anthropic/claude-opus-4.8',
    canonicalSlug: 'anthropic/claude-4.8-opus-20260528',
    displayName: 'Claude Opus 4.8',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'minimax/minimax-m3': {
    id: 'minimax/minimax-m3',
    canonicalSlug: 'minimax/minimax-m3-20260531',
    displayName: 'MiniMax M3',
    vendor: 'minimax',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'minimax/minimax-m2.7': {
    id: 'minimax/minimax-m2.7',
    canonicalSlug: 'minimax/minimax-m2.7-20260318',
    displayName: 'MiniMax M2.7',
    vendor: 'minimax',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'moonshotai/kimi-k2.7-code': {
    id: 'moonshotai/kimi-k2.7-code',
    canonicalSlug: 'moonshotai/kimi-k2.7-code-20260612',
    displayName: 'Kimi K2.7 Code',
    vendor: 'moonshotai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    canonicalSlug: 'google/gemini-3.1-pro-preview-20260219',
    displayName: 'Gemini 3.1 Pro Preview',
    vendor: 'google',
    role: 'judge',
    enabled: true,
    request: judgeRequest,
  },
  'x-ai/grok-4.5': {
    id: 'x-ai/grok-4.5',
    canonicalSlug: 'x-ai/grok-4.5-20260708',
    displayName: 'Grok 4.5',
    vendor: 'x-ai',
    role: 'judge',
    enabled: true,
    request: judgeRequest,
  },
  'z-ai/glm-5.2': {
    id: 'z-ai/glm-5.2',
    canonicalSlug: 'z-ai/glm-5.2-20260616',
    displayName: 'GLM 5.2',
    vendor: 'z-ai',
    role: 'judge',
    enabled: true,
    request: judgeRequest,
  },
};

export function listModels(role?: ModelRegistryEntry['role']): ModelRegistryEntry[] {
  return Object.values(MODEL_REGISTRY).filter(
    (model) => model.enabled && (!role || model.role === role),
  );
}

export function getModel(modelId: string): ModelRegistryEntry {
  const model = MODEL_REGISTRY[modelId];
  if (!model || !model.enabled) throw new Error(`Unknown or disabled model: ${modelId}`);
  return model;
}
