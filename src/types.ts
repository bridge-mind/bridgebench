import { z } from 'zod';

export const METHODOLOGY_VERSION = 'arena-v0.3.0';

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

/**
 * Each category is an independent arena: its own task pack, journal, Elo
 * ladder, leaderboard, and judge emphasis. Reasoning measures inference depth
 * on fully determinable tasks; hallucination measures epistemic discipline on
 * tasks seeded with false premises, missing evidence, and fabrication bait.
 */
export const BenchmarkCategorySchema = z.enum(['reasoning', 'hallucination']);
export type BenchmarkCategory = z.infer<typeof BenchmarkCategorySchema>;
export const CATEGORIES = BenchmarkCategorySchema.options;

export const CATEGORY_CLUSTERS: Record<BenchmarkCategory, readonly string[]> = {
  reasoning: [
    'stateful-execution',
    'constraint-reconciliation',
    'root-cause-reasoning',
    'multi-artifact-synthesis',
    'formal-counterexample',
    'uncertainty-adversarial',
  ],
  hallucination: [
    'false-premise',
    'missing-evidence',
    'entity-fabrication',
    'knowledge-boundary',
    'conflicting-sources',
    'citation-fidelity',
  ],
};

export const CATEGORY_META: Record<BenchmarkCategory, { label: string; tagline: string }> = {
  reasoning: {
    label: 'Reasoning',
    tagline:
      'Every task is fully determinable from its artifacts — the arena measures who derives the one defensible resolution.',
  },
  hallucination: {
    label: 'Hallucination',
    tagline:
      'Tasks are seeded with false premises, missing evidence, and fabrication bait — the arena measures who stays grounded instead of inventing.',
  },
};

export const TaskArtifactSchema = z.object({
  id: z.string().min(1).max(80),
  type: z.enum(['code', 'log', 'config', 'spec', 'diff', 'table', 'note']),
  label: z.string().min(1).max(160),
  content: z.string().min(1).max(40_000),
});
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskPublicSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: BenchmarkCategorySchema,
  // Cluster membership is validated against CATEGORY_CLUSTERS by the loader,
  // which knows which category it is loading.
  cluster: z.string().min(1).max(60),
  difficulty: z.enum(['hard', 'expert']),
  title: z.string().min(1).max(180),
  summary: z.string().min(1).max(500),
  prompt: z.string().min(1).max(10_000),
  artifacts: z.array(TaskArtifactSchema).min(1).max(20),
  tags: z.array(z.string().min(1).max(60)).default([]),
});
export type TaskPublic = z.infer<typeof TaskPublicSchema>;

export const TaskPrivateSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  expectedResolution: z.string().min(1).max(10_000),
  requiredEvidence: z.array(z.string().min(1)).min(1),
  disqualifyingErrors: z.array(z.string().min(1)).default([]),
  rubric: z.object({
    correctness: z.string().min(1),
    evidenceGrounding: z.string().min(1),
    constraintHandling: z.string().min(1),
    completeness: z.string().min(1),
  }),
});
export type TaskPrivate = z.infer<typeof TaskPrivateSchema>;

export interface ArenaTask {
  public: TaskPublic;
  /** Null when loaded without a private overlay (public checkout). */
  private: TaskPrivate | null;
  publicHash: string;
  privateHash: string | null;
}

/** A task whose hidden reference is present — required to run judged matches. */
export type CompleteArenaTask = ArenaTask & { private: TaskPrivate; privateHash: string };

export interface ArenaRunConfig {
  category: BenchmarkCategory;
  seed: string;
  matches: number;
  maxCostUsd: number;
  resume: boolean;
  /** Abort early when most matches are producing failed responses (default true). */
  healthStop?: boolean;
}

export type ArenaEventType =
  | 'run.started'
  | 'match.started'
  | 'competitor.delta'
  | 'competitors.completed'
  | 'judging.started'
  | 'judge.completed'
  | 'match.completed'
  | 'run.budget-stopped'
  | 'run.completed'
  | 'run.failed';

export interface ArenaEvent {
  id: string;
  type: ArenaEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type ArenaEventSink = (event: ArenaEvent) => void;

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

export interface ModelCompletion {
  generationId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Hidden deliberation tokens reported by the provider; undefined when not reported. */
  reasoningTokens?: number;
  costUsd: number;
  latencyMs: number;
  finishReason: string;
  /** How many transport attempts this completion took; undefined on legacy journal lines. */
  attempts?: number;
}

export interface CompetitorResponse extends ModelCompletion {
  modelId: string;
  success: boolean;
  error?: string;
}

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

export interface MatchResult {
  methodologyVersion: string;
  runId: string;
  matchId: string;
  scheduleIndex: number;
  seed: string;
  timestamp: string;
  task: {
    id: string;
    version: string;
    /** Absent on journal lines written before arena-v0.3.0 (reasoning-only era). */
    category?: BenchmarkCategory;
    cluster: string;
    publicHash: string;
    privateHash: string;
  };
  competitors: {
    modelA: string;
    modelB: string;
    responseA: CompetitorResponse;
    responseB: CompetitorResponse;
  };
  outcome: 'judged' | 'forfeit' | 'no-contest';
  winnerModelId: string | null;
  panel: PanelDecision | null;
  eloBefore: Record<string, number>;
  eloAfter: Record<string, number>;
  pointAwarded: boolean;
  matchCostUsd: number;
}

export interface LeaderboardEntry {
  rank: number;
  modelId: string;
  displayName: string;
  elo: number;
  points: number;
  wins: number;
  losses: number;
  forfeits: number;
  matches: number;
  winRate: number;
  unanimousWins: number;
  totalCostUsd: number;
  byCluster: Partial<Record<string, { wins: number; losses: number }>>;
}

export interface ArenaSnapshot {
  version: '0.2.0';
  methodologyVersion: string;
  category: BenchmarkCategory;
  generatedAt: string;
  initialElo: number;
  kFactor: number;
  leaderboard: LeaderboardEntry[];
  matches: MatchResult[];
}

export interface ChatRequest {
  model: ModelRegistryEntry;
  system: string;
  user: string;
  structured?: boolean;
  /** Called with the accumulated visible text as it streams in (throttled). */
  onDelta?: (text: string) => void;
}

export interface OpenRouterGateway {
  complete(request: ChatRequest): Promise<ModelCompletion>;
  validateModel(model: ModelRegistryEntry): Promise<void>;
}
