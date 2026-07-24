import type { ModelRegistryEntry, ModelRequestPolicy } from './types.js';

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
    judgeRequest,
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
  'anthropic/claude-opus-5': {
    id: 'anthropic/claude-opus-5',
    canonicalSlug: 'anthropic/claude-opus-5-20260724',
    displayName: 'Claude Opus 5',
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
  'anthropic/claude-opus-4.7': {
    id: 'anthropic/claude-opus-4.7',
    canonicalSlug: 'anthropic/claude-4.7-opus-20260416',
    displayName: 'Claude Opus 4.7',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'anthropic/claude-opus-4.6': {
    id: 'anthropic/claude-opus-4.6',
    canonicalSlug: 'anthropic/claude-4.6-opus-20260205',
    displayName: 'Claude Opus 4.6',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'openai/gpt-5.5': {
    id: 'openai/gpt-5.5',
    canonicalSlug: 'openai/gpt-5.5-20260423',
    displayName: 'GPT-5.5',
    vendor: 'openai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'qwen/qwen3.7-max': {
    id: 'qwen/qwen3.7-max',
    canonicalSlug: 'qwen/qwen3.7-max-20260520',
    displayName: 'Qwen 3.7 Max',
    vendor: 'qwen',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'moonshotai/kimi-k2.6': {
    id: 'moonshotai/kimi-k2.6',
    canonicalSlug: 'moonshotai/kimi-k2.6-20260420',
    displayName: 'Kimi K2.6',
    vendor: 'moonshotai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'moonshotai/kimi-k3': {
    id: 'moonshotai/kimi-k3',
    canonicalSlug: 'moonshotai/kimi-k3-20260715',
    displayName: 'Kimi K3',
    vendor: 'moonshotai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'meta/muse-spark-1.1': {
    id: 'meta/muse-spark-1.1',
    canonicalSlug: 'meta/muse-spark-1.1-20260709',
    displayName: 'Muse Spark 1.1',
    vendor: 'meta',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'deepseek/deepseek-v4-pro': {
    id: 'deepseek/deepseek-v4-pro',
    canonicalSlug: 'deepseek/deepseek-v4-pro-20260423',
    displayName: 'DeepSeek V4 Pro',
    vendor: 'deepseek',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'deepseek/deepseek-v4-flash': {
    id: 'deepseek/deepseek-v4-flash',
    canonicalSlug: 'deepseek/deepseek-v4-flash-20260423',
    displayName: 'DeepSeek V4 Flash',
    vendor: 'deepseek',
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
    judgeRequest,
  },
  // 2026-07-18 roster expansion: the Artificial Analysis Coding Index wave.
  // Canonical slugs pin the OpenRouter `canonical_slug` at add time.
  'anthropic/claude-sonnet-5': {
    id: 'anthropic/claude-sonnet-5',
    canonicalSlug: 'anthropic/claude-sonnet-5-20260630',
    displayName: 'Claude Sonnet 5',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'anthropic/claude-haiku-4.5': {
    id: 'anthropic/claude-haiku-4.5',
    canonicalSlug: 'anthropic/claude-4.5-haiku-20251001',
    displayName: 'Claude Haiku 4.5',
    vendor: 'anthropic',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'google/gemini-3.5-flash': {
    id: 'google/gemini-3.5-flash',
    canonicalSlug: 'google/gemini-3.5-flash-20260519',
    displayName: 'Gemini 3.5 Flash',
    vendor: 'google',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'google/gemma-4-31b-it': {
    id: 'google/gemma-4-31b-it',
    canonicalSlug: 'google/gemma-4-31b-it-20260402',
    displayName: 'Gemma 4 31B',
    vendor: 'google',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'xiaomi/mimo-v2.5-pro': {
    id: 'xiaomi/mimo-v2.5-pro',
    canonicalSlug: 'xiaomi/mimo-v2.5-pro-20260422',
    displayName: 'MiMo-V2.5-Pro',
    vendor: 'xiaomi',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  'openai/gpt-oss-120b': {
    id: 'openai/gpt-oss-120b',
    // gpt-oss-120b has no dated canonical variant on OpenRouter.
    canonicalSlug: 'openai/gpt-oss-120b',
    displayName: 'gpt-oss-120b',
    vendor: 'openai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  // Added 2026-07-19: Thinking Machines' debut model.
  'thinkingmachines/inkling': {
    id: 'thinkingmachines/inkling',
    canonicalSlug: 'thinkingmachines/inkling-20260715',
    displayName: 'Inkling',
    vendor: 'thinkingmachines',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
  },
  // Dual role since 2026-07-18: the three former judge-only entries now also
  // compete (they chart on the coding index the roster mirrors). Their pool
  // membership is unchanged — ARENA_JUDGE_POOL_IDS in the API still lists the
  // same seven ids, so no methodology bump — but vendor conflict exclusion
  // now removes them from any match where their vendor competes. Every match
  // excludes at most two vendors, and the pool spans seven distinct vendors,
  // so five eligible judges (3 primaries + 2 reserves) always remain.
  'google/gemini-3.1-pro-preview': {
    id: 'google/gemini-3.1-pro-preview',
    canonicalSlug: 'google/gemini-3.1-pro-preview-20260219',
    displayName: 'Gemini 3.1 Pro Preview',
    vendor: 'google',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
    judgeRequest,
  },
  // Until Mistral/Nemotron earn a spot in CALIBRATED_JUDGE_IDS (seating.ts)
  // via the gold calibration sets, seating still ranks them behind the
  // calibrated five: they serve as adjudication reserves, not primary
  // panelists.
  'mistralai/mistral-medium-3-5': {
    id: 'mistralai/mistral-medium-3-5',
    canonicalSlug: 'mistralai/mistral-medium-3.5-20260430',
    displayName: 'Mistral Medium 3.5',
    vendor: 'mistralai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
    judgeRequest,
  },
  'nvidia/nemotron-3-ultra-550b-a55b': {
    id: 'nvidia/nemotron-3-ultra-550b-a55b',
    canonicalSlug: 'nvidia/nemotron-3-ultra-550b-a55b-20260604',
    displayName: 'Nemotron 3 Ultra',
    vendor: 'nvidia',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
    judgeRequest,
  },
  // Dual role (Grok 4.5, GLM 5.2 — plus GPT-5.6 Sol and Kimi K2.7 Code
  // above): carrying `judgeRequest` puts a competitor in the judge pool.
  // Judge-side calls use `judgeRequest`. Since arena-v0.4.0 each match seats
  // three judges from this pool (seating.ts): a model never judges a match
  // where it — or any model from its vendor — competes.
  'x-ai/grok-4.5': {
    id: 'x-ai/grok-4.5',
    canonicalSlug: 'x-ai/grok-4.5-20260708',
    displayName: 'Grok 4.5',
    vendor: 'x-ai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
    judgeRequest,
  },
  'z-ai/glm-5.2': {
    id: 'z-ai/glm-5.2',
    canonicalSlug: 'z-ai/glm-5.2-20260616',
    displayName: 'GLM 5.2',
    vendor: 'z-ai',
    role: 'competitor',
    enabled: true,
    request: competitorRequest,
    judgeRequest,
  },
};

export const SOL_FABLE_PILOT_COMPETITOR_IDS = [
  'openai/gpt-5.6-sol',
  'anthropic/claude-fable-5',
] as const;

/**
 * A model sits on the judge panel if judging is its primary role or if it is
 * a dual-role competitor carrying a `judgeRequest` policy.
 */
function sitsOnJudgePanel(model: ModelRegistryEntry): boolean {
  return model.role === 'judge' || model.judgeRequest !== undefined;
}

/**
 * The entry as it acts on the judge panel: role `judge`, judge request
 * policy. Pure-judge entries pass through unchanged.
 */
function asJudge(model: ModelRegistryEntry): ModelRegistryEntry {
  if (model.role === 'judge') return model;
  return { ...model, role: 'judge', request: model.judgeRequest as ModelRequestPolicy };
}

export function listModels(role?: ModelRegistryEntry['role']): ModelRegistryEntry[] {
  const enabled = Object.values(MODEL_REGISTRY).filter((model) => model.enabled);
  if (role === 'judge') return enabled.filter(sitsOnJudgePanel).map(asJudge);
  return enabled.filter((model) => !role || model.role === role);
}

/** Resolve a judge-panel member as its acting-judge view, or throw. */
export function getJudgeModel(modelId: string): ModelRegistryEntry {
  const model = MODEL_REGISTRY[modelId];
  if (!model || !model.enabled || !sitsOnJudgePanel(model)) {
    throw new Error(`Unknown or disabled judge model: ${modelId}`);
  }
  return asJudge(model);
}

/**
 * Resolve an optional run roster in registry order so repeated CLI flags are
 * order-insensitive while the existing default schedule remains unchanged.
 */
export function resolveCompetitorRoster(
  requestedCompetitorIds?: readonly string[],
): ModelRegistryEntry[] {
  const competitorIds = requestedCompetitorIds ?? listModels('competitor').map((model) => model.id);

  const duplicateIds = [
    ...new Set(competitorIds.filter((id, index) => competitorIds.indexOf(id) !== index)),
  ];
  if (duplicateIds.length > 0) {
    throw new Error(`Competitor roster entries must be unique: ${duplicateIds.join(', ')}`);
  }

  for (const modelId of competitorIds) {
    const model = MODEL_REGISTRY[modelId];
    if (!model) throw new Error(`Unknown competitor model: ${modelId || '<empty>'}`);
    if (!model.enabled) throw new Error(`Competitor model is disabled: ${modelId}`);
    if (model.role !== 'competitor') {
      throw new Error(`Model ${modelId} has role=${model.role}; competitor role required`);
    }
  }

  if (competitorIds.length < 2) {
    throw new Error('Competitor roster must contain at least two enabled competitor models');
  }

  const selected = new Set(competitorIds);
  return Object.values(MODEL_REGISTRY).filter(
    (model) => model.enabled && model.role === 'competitor' && selected.has(model.id),
  );
}

export function getModel(modelId: string): ModelRegistryEntry {
  const model = MODEL_REGISTRY[modelId];
  if (!model || !model.enabled) throw new Error(`Unknown or disabled model: ${modelId}`);
  return model;
}
