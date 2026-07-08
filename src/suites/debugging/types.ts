/**
 * Debugging Bench types — public task specs, hidden overlays, submission
 * contract, and result shapes.
 *
 * Task YAML files are validated with Zod at the boundary. Public tasks live
 * in tasks/current/debugging/; hidden overlays (tests + answer keys) live in
 * bridgebench-private during the season and are published at retirement.
 *
 * See docs/debugging-bench-plan.md for the full methodology.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Clusters (evidence surfaces) & difficulty
// ---------------------------------------------------------------------------

export const DebugClusterSchema = z.enum([
  'test-failure',
  'runtime-exception',
  'incorrect-output',
  'async-timing',
  'state-mutation',
  'regression-after-refactor',
]);

export type DebugCluster = z.infer<typeof DebugClusterSchema>;

export const DEBUG_CLUSTERS: DebugCluster[] = DebugClusterSchema.options;

export const DebugDifficultySchema = z.enum(['medium', 'hard', 'expert']);

export type DebugDifficulty = z.infer<typeof DebugDifficultySchema>;

// ---------------------------------------------------------------------------
// Test cases (shared shape between public repro and hidden suites)
// ---------------------------------------------------------------------------

/**
 * One deterministic test case executed against the module's entry point.
 *
 * `call` describes the invocation as a small script: which export to call
 * and with what arguments. For stateful/multi-step scenarios, `steps`
 * expresses a sequence of calls whose final (or per-step) results are
 * asserted. All values must be plain JSON — determinism is non-negotiable.
 */
export const DebugCallSchema = z.object({
  /** Exported symbol to invoke (default: the task entryPoint symbol). */
  symbol: z.string().optional(),
  args: z.array(z.unknown()).default([]),
  /** Assert this call's return value (deep-equal after JSON normalization). */
  expect: z.unknown().optional(),
  /** Assert this call rejects/throws with a message containing the string. */
  expectThrowsContaining: z.string().optional(),
});

export type DebugCall = z.infer<typeof DebugCallSchema>;

export const DebugTestCaseSchema = z.object({
  description: z.string().min(1),
  /** Single-call form. */
  call: DebugCallSchema.optional(),
  /** Multi-step stateful form: calls run in order in one fresh sandbox. */
  steps: z.array(DebugCallSchema).optional(),
  /**
   * Behavioral contract assertions evaluated after the calls, e.g.
   * { spy: "loadFromDisk", maxCalls: 1 } — used to assert memoization /
   * batching contracts that a naive rewrite would silently break.
   */
  contracts: z
    .array(
      z.object({
        spy: z.string(),
        minCalls: z.number().int().min(0).optional(),
        maxCalls: z.number().int().min(0).optional(),
      }),
    )
    .default([]),
  /** Virtual-clock timeout in ms for async cases (real wall clock capped separately). */
  virtualTimeoutMs: z.number().int().positive().default(10_000),
});

export type DebugTestCase = z.infer<typeof DebugTestCaseSchema>;

// ---------------------------------------------------------------------------
// Public task spec (tasks/current/debugging/<id>.yaml)
// ---------------------------------------------------------------------------

export const DebugSourceFileSchema = z.object({
  /** Repo-relative virtual path, e.g. "src/cache.ts". Forward slashes only. */
  path: z.string().regex(/^[a-z0-9-_./]+\.ts$/i),
  contents: z.string().min(1),
});

export type DebugSourceFile = z.infer<typeof DebugSourceFileSchema>;

export const DebugVisibleEvidenceSchema = z.object({
  userReport: z.string().optional(),
  stackTrace: z.string().optional(),
  failingTestOutput: z.string().optional(),
  notes: z.array(z.string()).default([]),
});

export type DebugVisibleEvidence = z.infer<typeof DebugVisibleEvidenceSchema>;

export const DebugConstraintsSchema = z.object({
  /** Every original export (all files) must keep its name and arity. */
  preserveExports: z.boolean().default(true),
  /** The patch may not add imports beyond the module's own files. */
  forbidNewDependencies: z.boolean().default(true),
  /** If set, the patch may only modify these paths (others are read-only). */
  editablePaths: z.array(z.string()).optional(),
  /** Soft ceiling on AST edit ratio before patch-discipline penalties. */
  maxAstEditRatio: z.number().min(0).max(1).default(0.35),
});

export type DebugConstraints = z.infer<typeof DebugConstraintsSchema>;

export const DebugBenchTaskSchema = z.object({
  id: z
    .string()
    .regex(/^s\d+-debug-[a-z0-9-]+$/, 'task ids look like s1-debug-<slug>'),
  season: z.number().int().positive(),
  cluster: DebugClusterSchema,
  difficulty: DebugDifficultySchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  /** Evidence-first prompt. Must NOT point at the defect. */
  prompt: z.string().min(1),
  /** The buggy multi-file TypeScript module (pure TS, no dependencies). */
  files: z.array(DebugSourceFileSchema).min(1),
  /** Module path + exported symbol(s) the harness drives, e.g. "src/index.ts". */
  entryModule: z.string(),
  entrySymbols: z.array(z.string()).min(1),
  visibleEvidence: DebugVisibleEvidenceSchema,
  /** Deliberately narrow — hidden coverage does the real work. */
  publicReproTests: z.array(DebugTestCaseSchema).min(1),
  constraints: DebugConstraintsSchema.default({}),
  responseContract: z
    .object({
      diagnosisRequired: z.boolean().default(true),
      codeRequired: z.literal(true).default(true),
    })
    .default({ diagnosisRequired: true, codeRequired: true }),
});

export type DebugBenchTask = z.infer<typeof DebugBenchTaskSchema>;

// ---------------------------------------------------------------------------
// Hidden overlay (bridgebench-private: tasks/current/debugging/<id>.hidden.yaml)
// ---------------------------------------------------------------------------

export const DebugStructuralAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('entrypoint_preserved') }),
  z.object({ type: z.literal('export_shape_preserved') }),
  z.object({ type: z.literal('no_new_imports') }),
  z.object({ type: z.literal('max_ast_edit_ratio'), ratio: z.number().min(0).max(1) }),
  z.object({ type: z.literal('symbol_still_exists'), symbol: z.string(), path: z.string() }),
  z.object({ type: z.literal('forbidden_pattern_absent'), pattern: z.string(), reason: z.string() }),
  z.object({ type: z.literal('required_pattern_present'), pattern: z.string(), reason: z.string() }),
]);

export type DebugStructuralAssertion = z.infer<typeof DebugStructuralAssertionSchema>;

export const DebugDiagnosisAnswerKeySchema = z.object({
  /** Any one match (case-insensitive substring) credits root cause. */
  acceptableRootCausePhrases: z.array(z.string()).min(1),
  bugCategory: z.string(),
  affectedFiles: z.array(z.string()).min(1),
  affectedSymbols: z.array(z.string()).min(1),
  /** Keywords expected in whyItFails; scored proportionally. */
  explanationKeywords: z.array(z.string()).default([]),
});

export type DebugDiagnosisAnswerKey = z.infer<typeof DebugDiagnosisAnswerKeySchema>;

export const DebugHiddenOverlaySchema = z.object({
  id: z.string(),
  season: z.number().int().positive(),
  /** Same defect, every other path — kills shallow special-case patches. */
  hiddenBugTests: z.array(DebugTestCaseSchema).min(1),
  /** Adjacent behavior incl. behavioral contracts (memoization, batching…). */
  hiddenRegressionTests: z.array(DebugTestCaseSchema).min(1),
  diagnosisAnswerKey: DebugDiagnosisAnswerKeySchema,
  structuralAssertions: z.array(DebugStructuralAssertionSchema).default([]),
  /** Private analysis tags (off-by-one, stale-cache…). Published at retirement. */
  bugTags: z.array(z.string()).default([]),
  /** Optional per-task weight overrides (rare; must sum to 100 with defaults). */
  scoringWeights: z
    .object({
      visibleReproFix: z.number().optional(),
      hiddenBugCoverage: z.number().optional(),
      regressionResistance: z.number().optional(),
      rootCauseAccuracy: z.number().optional(),
      patchDiscipline: z.number().optional(),
      efficiency: z.number().optional(),
    })
    .optional(),
});

export type DebugHiddenOverlay = z.infer<typeof DebugHiddenOverlaySchema>;

/** A task merged with its hidden overlay (when BRIDGEBENCH_PRIVATE_DIR is set). */
export interface LoadedDebugTask {
  task: DebugBenchTask;
  hidden: DebugHiddenOverlay | null;
}

// ---------------------------------------------------------------------------
// Submission contract — what the extractor recovers from raw model output
// ---------------------------------------------------------------------------

export const DebugDiagnosisSchema = z.object({
  rootCause: z.string(),
  bugCategory: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  affectedFiles: z.array(z.string()).default([]),
  affectedSymbols: z.array(z.string()).default([]),
  whyItFails: z.string(),
});

export type DebugDiagnosis = z.infer<typeof DebugDiagnosisSchema>;

export interface DebugSubmission {
  diagnosis: DebugDiagnosis | null;
  /** Full replacement contents keyed by virtual path; unchanged files inherit. */
  patchedFiles: Map<string, string>;
  extractionWarnings: string[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export const DEBUG_SCORE_WEIGHTS = {
  visibleReproFix: 15,
  hiddenBugCoverage: 30,
  regressionResistance: 25,
  rootCauseAccuracy: 15,
  patchDiscipline: 10,
  efficiency: 5,
} as const;

/** Visible repro still failing → total capped here. */
export const CAP_VISIBLE_REPRO_FAILING = 49;
/** Repro fixed but regression resistance below threshold → capped here. */
export const CAP_LOW_REGRESSION_RESISTANCE = 69;
/** Regression pass-rate threshold below which the 69 cap applies. */
export const REGRESSION_RESISTANCE_FLOOR = 0.8;

export interface DebugSuiteResult {
  passed: number;
  total: number;
  failures: Array<{ description: string; detail: string }>;
}

export interface DebugScoreBreakdown {
  visibleReproFix: number;
  hiddenBugCoverage: number;
  regressionResistance: number;
  rootCauseAccuracy: number;
  patchDiscipline: number;
  efficiency: number;
  total: number;
  hardFailed: boolean;
  hardFailReason?: string;
  capApplied?: number;
}

export interface DebugPatchAnalysis {
  exportsPreserved: boolean;
  entryPointsPreserved: boolean;
  newImports: string[];
  astEditRatio: number;
  editedPaths: string[];
  violations: string[];
}

export interface DebugTaskResult {
  suite: 'debugging';
  season: number;
  taskId: string;
  cluster: DebugCluster;
  difficulty: DebugDifficulty;
  modelId: string;
  displayName: string;
  repeatIndex: number;
  rawResponseSha256: string;
  diagnosis: DebugDiagnosis | null;
  visibleRepro: DebugSuiteResult;
  hiddenBug: DebugSuiteResult | null;
  hiddenRegression: DebugSuiteResult | null;
  patchAnalysis: DebugPatchAnalysis | null;
  scores: DebugScoreBreakdown;
  /** True when hidden overlays were unavailable (public run) — flagged partial. */
  partial: boolean;
  providerResponseMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  errorType?: string;
  timestamp: string;
}
