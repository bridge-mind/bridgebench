import { z } from 'zod';

import { BenchmarkCategorySchema, type BenchmarkCategory } from './categories.js';
import { ModelCompletionSchema, type ModelCompletion } from './models.js';

export interface ArenaRunConfig {
  category: BenchmarkCategory;
  seed: string;
  matches: number;
  maxCostUsd: number;
  resume: boolean;
  /** Omit to use every enabled competitor in the registry. */
  competitorIds?: readonly string[];
  /** Abort early when most matches contain a failed response. */
  healthStop?: boolean;
}

export interface ArenaExecutionOptions {
  /** Execution-only cancellation; deliberately excluded from the canonical manifest. */
  signal?: AbortSignal;
  /**
   * Invoked after each match result is journaled, before the next match
   * starts. Used to publish results incrementally instead of only at run end.
   * Must not throw; handle and log failures internally.
   */
  onMatchResult?: (result: MatchResult) => Promise<void> | void;
}

export interface ArenaRunResult {
  runId: string;
  completed: number;
  costUsd: number;
  stoppedForBudget: boolean;
  /** True when the failure-rate circuit breaker ended the run early (graceful, not a crash). */
  stoppedForHealth: boolean;
  cancelled: boolean;
}

export interface ScheduledMatch {
  id: string;
  runId: string;
  index: number;
  seed: string;
  category: BenchmarkCategory;
  taskId: string;
  modelA: string;
  modelB: string;
}

const CompetitorSuccessSchema = ModelCompletionSchema.extend({
  modelId: z.string().min(1),
  success: z.literal(true),
});
export type CompetitorSuccess = z.infer<typeof CompetitorSuccessSchema>;

const CompetitorFailureSchema = z.object({
  modelId: z.string().min(1),
  success: z.literal(false),
  error: z.string().min(1),
  latencyMs: z.number().finite().nonnegative(),
  attempts: z.number().int().positive().optional(),
});
export type CompetitorFailure = z.infer<typeof CompetitorFailureSchema>;

const LegacyCompetitorFailureSchema = z
  .object({
    modelId: z.string().min(1),
    success: z.literal(false),
    error: z.string().min(1),
    generationId: z.string(),
    content: z.string(),
    inputTokens: z.number().finite().nonnegative(),
    outputTokens: z.number().finite().nonnegative(),
    reasoningTokens: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    finishReason: z.string(),
    attempts: z.number().int().positive().optional(),
  })
  .transform(({ modelId, error, latencyMs, attempts }) => ({
    modelId,
    success: false as const,
    error,
    latencyMs,
    ...(attempts === undefined ? {} : { attempts }),
  }));

export type CompetitorResponse = CompetitorSuccess | CompetitorFailure;
export const CompetitorResponseSchema: z.ZodType<CompetitorResponse> = z.union([
  CompetitorSuccessSchema,
  CompetitorFailureSchema,
  LegacyCompetitorFailureSchema,
]);

export const JudgeVerdictSchema = z.object({
  winner: z.enum(['MODEL_A', 'MODEL_B']),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(4_000),
  criteria: z.object({
    correctness: z.string().min(1).max(1_000),
    grounding: z.string().min(1).max(1_000),
    constraintHandling: z.string().min(1).max(1_000),
    completeness: z.string().min(1).max(1_000),
  }),
  violations: z.array(z.string().max(500)).max(20),
});
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;

/**
 * Provider-safe JSON Schema subset generated from the same verdict shape.
 * Runtime Zod parsing above enforces the local string and array limits.
 */
export const JUDGE_VERDICT_TRANSPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'confidence', 'rationale', 'criteria', 'violations'],
  properties: {
    winner: { type: 'string', enum: ['MODEL_A', 'MODEL_B'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    criteria: {
      type: 'object',
      additionalProperties: false,
      required: ['correctness', 'grounding', 'constraintHandling', 'completeness'],
      properties: {
        correctness: { type: 'string' },
        grounding: { type: 'string' },
        constraintHandling: { type: 'string' },
        completeness: { type: 'string' },
      },
    },
    violations: { type: 'array', items: { type: 'string' } },
  },
} as const;

export interface JudgeVote {
  judgeModelId: string;
  modelAIdentity: string;
  modelBIdentity: string;
  verdict: JudgeVerdict | null;
  winnerModelId: string | null;
  completion: ModelCompletion | null;
  error?: string;
}

export interface PanelDecision {
  winnerModelId: string | null;
  validVotes: number;
  votesByModel: Record<string, number>;
  agreement: 'unanimous' | 'split' | 'insufficient';
  votes: JudgeVote[];
}

export interface EloState {
  ratings: Record<string, number>;
  points: Record<string, number>;
}

/** Per-competitor latency measurements the speed arena decides matches by. */
export interface SpeedMetric {
  /** Time to first token: ms from request start to the first non-empty content delta. */
  ttftMs: number;
  /** Output tokens per second over the generation window: outputTokens / max(1e-3, (totalMs - ttftMs)/1000). */
  tps: number;
  /** Total wall-clock ms from request start to stream completion — the value that decides the winner. */
  totalMs: number;
  outputTokens: number;
}

/** Present only on 'speed-decided' matches; `a` is modelA's measurement, `b` is modelB's. */
export interface SpeedMetrics {
  a: SpeedMetric;
  b: SpeedMetric;
}

const SpeedMetricSchema: z.ZodType<SpeedMetric> = z.object({
  ttftMs: z.number().finite().nonnegative(),
  tps: z.number().finite().nonnegative(),
  totalMs: z.number().finite().nonnegative(),
  outputTokens: z.number().finite().nonnegative(),
});

export const SpeedMetricsSchema: z.ZodType<SpeedMetrics> = z.object({
  a: SpeedMetricSchema,
  b: SpeedMetricSchema,
});

export interface MatchResult {
  methodologyVersion: string;
  runId: string;
  /** Absent on legacy journal lines written before run manifests. */
  runManifestHash?: string;
  matchId: string;
  scheduleIndex: number;
  seed: string;
  timestamp: string;
  task: {
    id: string;
    version: string;
    /** Absent on reasoning-only legacy lines. */
    category?: BenchmarkCategory;
    cluster: string;
    publicHash: string;
    /** Null for public-only packs (e.g. the speed arena), which have no hidden half. */
    privateHash: string | null;
  };
  competitors: {
    modelA: string;
    modelB: string;
    responseA: CompetitorResponse;
    responseB: CompetitorResponse;
  };
  outcome: 'judged' | 'forfeit' | 'no-contest' | 'speed-decided';
  winnerModelId: string | null;
  panel: PanelDecision | null;
  /** Present only when outcome is 'speed-decided'; null (or absent) otherwise. */
  speedMetrics?: SpeedMetrics | null;
  eloBefore: Record<string, number>;
  eloAfter: Record<string, number>;
  pointAwarded: boolean;
  matchCostUsd: number;
}

const NumericRecordSchema = z.record(z.number().finite());

export const JudgeVoteSchema: z.ZodType<JudgeVote> = z.object({
  judgeModelId: z.string().min(1),
  modelAIdentity: z.string().min(1),
  modelBIdentity: z.string().min(1),
  verdict: JudgeVerdictSchema.nullable(),
  winnerModelId: z.string().min(1).nullable(),
  completion: ModelCompletionSchema.nullable(),
  error: z.string().optional(),
});

export const PanelDecisionSchema: z.ZodType<PanelDecision> = z.object({
  winnerModelId: z.string().min(1).nullable(),
  validVotes: z.number().int().nonnegative(),
  votesByModel: NumericRecordSchema,
  agreement: z.enum(['unanimous', 'split', 'insufficient']),
  votes: z.array(JudgeVoteSchema),
});

export const MatchResultSchema: z.ZodType<MatchResult> = z.object({
  methodologyVersion: z.string().min(1),
  runId: z.string().min(1),
  runManifestHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  matchId: z.string().min(1),
  scheduleIndex: z.number().int().nonnegative(),
  seed: z.string(),
  timestamp: z.string().datetime(),
  task: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    category: BenchmarkCategorySchema.optional(),
    cluster: z.string().min(1),
    publicHash: z.string().min(1),
    privateHash: z.string().min(1).nullable(),
  }),
  competitors: z.object({
    modelA: z.string().min(1),
    modelB: z.string().min(1),
    responseA: CompetitorResponseSchema,
    responseB: CompetitorResponseSchema,
  }),
  outcome: z.enum(['judged', 'forfeit', 'no-contest', 'speed-decided']),
  winnerModelId: z.string().min(1).nullable(),
  panel: PanelDecisionSchema.nullable(),
  speedMetrics: SpeedMetricsSchema.nullable().optional(),
  eloBefore: NumericRecordSchema,
  eloAfter: NumericRecordSchema,
  pointAwarded: z.boolean(),
  matchCostUsd: z.number().finite().nonnegative(),
});

export function competitorCost(response: CompetitorResponse): number {
  return response.success ? response.costUsd : 0;
}

export function competitorOutputTokens(response: CompetitorResponse): number {
  return response.success ? response.outputTokens : 0;
}

export function competitorReasoningTokens(response: CompetitorResponse): number | undefined {
  return response.success ? response.reasoningTokens : undefined;
}

export function competitorContent(response: CompetitorResponse): string {
  return response.success ? response.content : '';
}
