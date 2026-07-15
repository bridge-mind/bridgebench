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
  // Dual role (Grok 4.5, GLM 5.2): they compete in the arena AND keep their
  // seats on the judge panel. Judge-side calls use `judgeRequest`; their own
  // matches are judged under the same blind protocol as every other match.
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
