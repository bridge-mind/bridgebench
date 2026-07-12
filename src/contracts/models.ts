import { z } from 'zod';

export const ModelRoleSchema = z.enum(['competitor', 'judge']);
export type ModelRole = z.infer<typeof ModelRoleSchema>;

export interface ModelRequestPolicy {
  maxTokens: number;
  temperature: number;
  reasoningEffort: 'high' | 'medium' | 'low';
  excludeReasoning: boolean;
  timeoutMs: number;
}

export interface ModelRegistryEntry {
  id: string;
  canonicalSlug: string;
  displayName: string;
  vendor: string;
  role: ModelRole;
  enabled: boolean;
  request: ModelRequestPolicy;
}

export const ModelCompletionSchema = z.object({
  generationId: z.string(),
  content: z.string(),
  inputTokens: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
  reasoningTokens: z.number().finite().nonnegative().optional(),
  costUsd: z.number().finite().nonnegative(),
  latencyMs: z.number().finite().nonnegative(),
  finishReason: z.string(),
  attempts: z.number().int().positive().optional(),
});
export type ModelCompletion = z.infer<typeof ModelCompletionSchema>;

export interface ChatRequest {
  model: ModelRegistryEntry;
  system: string;
  user: string;
  structured?: boolean;
  /** Execution-only cancellation; never serialized into a run manifest or provider payload. */
  signal?: AbortSignal;
  /** Called with the accumulated visible text as it streams in (throttled). */
  onDelta?: (text: string) => void;
}

export interface OpenRouterGateway {
  complete(request: ChatRequest): Promise<ModelCompletion>;
  validateModel(model: ModelRegistryEntry, signal?: AbortSignal): Promise<void>;
}
