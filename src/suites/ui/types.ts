/**
 * UI Bench types — task specs, the probe DSL, and result shapes (snapshot v3).
 *
 * Task YAML files are validated with Zod at the boundary; everything the
 * journal or snapshot persists is typed here.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Task categories
// ---------------------------------------------------------------------------

export const UiTaskCategorySchema = z.enum(['simulation', 'interactive', 'game', 'typography']);

export type UiTaskCategory = z.infer<typeof UiTaskCategorySchema>;

export const UI_TASK_CATEGORIES: UiTaskCategory[] = UiTaskCategorySchema.options;

// ---------------------------------------------------------------------------
// Public task spec (tasks/current/ui/<id>.yaml)
// ---------------------------------------------------------------------------

export const UiControlSchema = z.object({
  /** Stable selector value — the artifact must set data-bb-control="<id>". */
  id: z.string().min(1),
  kind: z.enum(['button', 'slider', 'canvas']),
  label: z.string(),
  /** Human description of what the control must do (quoted in the prompt). */
  behavior: z.string(),
});

export type UiControl = z.infer<typeof UiControlSchema>;

export const UiScreenshotSpecSchema = z.object({
  /** Milliseconds after settle when the shot is taken. */
  at: z.number().min(0),
  name: z.string().min(1),
});

export type UiScreenshotSpec = z.infer<typeof UiScreenshotSpecSchema>;

export const UiBenchTaskSchema = z.object({
  id: z
    .string()
    .regex(/^s\d+-[a-z0-9-]+$/, 'task ids are season-prefixed kebab-case, e.g. s1-lava-lamp-redux'),
  season: z.number().int().positive(),
  title: z.string().min(1),
  category: UiTaskCategorySchema,
  requiresWebGL: z.boolean().default(true),
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .default({ width: 1280, height: 800 }),
  /** Library pins the artifact may import (currently only three). */
  libraries: z.record(z.string()).default({}),
  controls: z.array(UiControlSchema).default([]),
  screenshots: z.array(UiScreenshotSpecSchema).default([
    { at: 0, name: 'hero' },
    { at: 2500, name: 'motion' },
  ]),
  /** Trusted task-specific direction elevated into the model's system message. */
  systemPrompt: z.string().min(1).optional(),
  prompt: z.string().min(1),
});

export type UiBenchTask = z.infer<typeof UiBenchTaskSchema>;

// ---------------------------------------------------------------------------
// Probe DSL (private overlay: <taskId>.probes.yaml — hidden during a season)
// ---------------------------------------------------------------------------

export const ProbeStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reset'), seed: z.number() }),
  z.object({ action: z.literal('waitMs'), ms: z.number().min(0).max(15_000) }),
  /** Screenshot the canvas (or full viewport) and remember it under `name`. */
  z.object({ action: z.literal('snapshot'), name: z.string() }),
  /** Remember BridgeBenchTaskApi.getState() under `name`. */
  z.object({ action: z.literal('getState'), name: z.string() }),
  z.object({
    action: z.literal('click'),
    /** CSS selector (e.g. [data-bb-control='color-cycle']) … */
    selector: z.string().optional(),
    /** … or canvas-relative percent coordinates. */
    at: z.object({ xPct: z.number(), yPct: z.number() }).optional(),
  }),
  z.object({
    action: z.literal('drag'),
    from: z.object({ xPct: z.number(), yPct: z.number() }),
    to: z.object({ xPct: z.number(), yPct: z.number() }),
    steps: z.number().int().min(2).max(60).default(12),
  }),
  z.object({
    action: z.literal('wheel'),
    deltaY: z.number(),
    at: z.object({ xPct: z.number(), yPct: z.number() }).optional(),
  }),
  z.object({
    action: z.literal('setSlider'),
    selector: z.string(),
    /** Set to this fraction of the slider range [0,1]. */
    fraction: z.number().min(0).max(1),
  }),
  z.object({ action: z.literal('press'), key: z.string() }),
  z.object({ action: z.literal('move'), to: z.object({ xPct: z.number(), yPct: z.number() }) }),
]);

export type ProbeStep = z.infer<typeof ProbeStepSchema>;

export type ProbeAssert =
  | { type: 'pixelDeltaVs'; ref: string; minChangedPct: number }
  | { type: 'pixelDeltaBelow'; ref: string; maxChangedPct: number }
  | { type: 'hueShiftVs'; ref: string; minDegrees: number }
  /** Motion rate increased: changed% between (fastA,fastB) ≥ minFactor × changed% between (slowA,slowB). */
  | {
      type: 'motionIncreased';
      slowA: string;
      slowB: string;
      fastA: string;
      fastB: string;
      minFactor: number;
    }
  /** Mean-luminance ratio of the CURRENT frame vs a named snapshot. */
  | { type: 'luminanceRatioVs'; ref: string; minRatio?: number; maxRatio?: number }
  | { type: 'stateChangedVs'; ref: string; path?: string }
  | { type: 'stateUnchangedVs'; ref: string; path?: string }
  | { type: 'statePathExists'; path: string }
  | { type: 'stateSerializable' }
  | { anyOf: ProbeAssert[] };

export const ProbeAssertSchema: z.ZodType<ProbeAssert> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('pixelDeltaVs'), ref: z.string(), minChangedPct: z.number() }),
    z.object({ type: z.literal('pixelDeltaBelow'), ref: z.string(), maxChangedPct: z.number() }),
    z.object({ type: z.literal('hueShiftVs'), ref: z.string(), minDegrees: z.number() }),
    z.object({
      type: z.literal('motionIncreased'),
      slowA: z.string(),
      slowB: z.string(),
      fastA: z.string(),
      fastB: z.string(),
      minFactor: z.number().positive(),
    }),
    z.object({
      type: z.literal('luminanceRatioVs'),
      ref: z.string(),
      minRatio: z.number().optional(),
      maxRatio: z.number().optional(),
    }),
    z.object({ type: z.literal('stateChangedVs'), ref: z.string(), path: z.string().optional() }),
    z.object({ type: z.literal('stateUnchangedVs'), ref: z.string(), path: z.string().optional() }),
    z.object({ type: z.literal('statePathExists'), path: z.string() }),
    z.object({ type: z.literal('stateSerializable') }),
    z.object({ anyOf: z.array(ProbeAssertSchema).min(1) }),
  ]),
);

export const UiProbeSchema = z.object({
  id: z.string().min(1),
  weight: z.number().positive().default(1),
  steps: z.array(ProbeStepSchema).min(1),
  asserts: z.array(ProbeAssertSchema).min(1),
});

export type UiProbe = z.infer<typeof UiProbeSchema>;

export const UiProbeOverlaySchema = z.object({
  id: z.string(),
  probes: z.array(UiProbeSchema).min(1),
  scoringOverrides: z
    .object({
      /** Motion detection threshold override (changed-pixel %). */
      motionMinChangedPct: z.number().optional(),
      /** Determinism replay tolerance override (changed-pixel %). */
      determinismMaxChangedPct: z.number().optional(),
    })
    .optional(),
});

export type UiProbeOverlay = z.infer<typeof UiProbeOverlaySchema>;

/** A task plus its private overlay (when BRIDGEBENCH_PRIVATE_DIR is set). */
export interface UiBenchFullTask extends UiBenchTask {
  probes: UiProbe[] | null;
  scoringOverrides: UiProbeOverlay['scoringOverrides'] | null;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface UiArtifactValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  metadata: {
    sizeBytes: number;
    hasDoctype: boolean;
    hasHtmlTag: boolean;
    hasManifest: boolean;
    hasTaskApi: boolean;
    hasImportMap: boolean;
    importMapCanonical: boolean;
    usesThree: boolean;
    moduleSpecifiers: string[];
    externalAssetRefs: string[];
    forbiddenApiRefs: string[];
    declaredControlIds: string[];
  };
}

// ---------------------------------------------------------------------------
// Evaluation result (Playwright Phase A + Phase B)
// ---------------------------------------------------------------------------

export interface UiProbeResult {
  id: string;
  weight: number;
  passed: boolean;
  error?: string;
  details?: string;
}

export interface UiArtifactEvaluationResult {
  ok: boolean;
  error?: string;
  evaluationTimeMs: number;
  browser: {
    executablePath: string;
    viewport: { width: number; height: number };
  };
  consoleErrorCount: number;
  consoleWarningCount: number;
  consoleSample: Array<{ type: string; text: string }>;
  pageErrors: string[];
  networkRequestsBlocked: number;
  vendorRequestsServed: number;
  startupTimeMs: number;
  /** ms until both harness globals appeared (null = never). */
  harnessGlobalsMs: number | null;
  webgl: {
    requestedContexts: string[];
    active: 'webgl2' | 'webgl' | '2d' | null;
    renderer: string | null;
  };
  /** rAF frames per second sampled over ~2s (SwiftShader — diagnostic only). */
  fps: number | null;
  animation: {
    detected: boolean;
    /** Changed-pixel % between consecutive sampled frames. */
    changedPct: number[];
  };
  blankFrame: boolean;
  /** Gallery screenshots: name → absolute path. */
  screenshots: Record<string, string>;
  /** null = no private probes available for this run (partial scoring). */
  probes: UiProbeResult[] | null;
  determinism: {
    ran: boolean;
    replayChangedPct: number | null;
    statesMatch: boolean | null;
    error?: string;
  };
  /** data-bb-control ids actually present in the live DOM. */
  controlsFound: string[];
  viewportFill: boolean;
  getScoreOk: boolean;
  destroyOk: boolean;
}

// ---------------------------------------------------------------------------
// Qualification (v3): the harness NEVER grades quality — builders do, via
// blind A/B community voting (Elo) on bridgebench.ai. The harness only
// decides arena eligibility (objective pass/fail) and records informational
// diagnostics shown as badges next to artifacts.
// ---------------------------------------------------------------------------

export interface UiDiagnostics {
  webglActive: 'webgl2' | 'webgl' | '2d' | null;
  /** Task declared requiresWebGL and a GL context was actually created. */
  webglRequirementMet: boolean;
  fps: number | null;
  animationDetected: boolean;
  controlsDeclared: number;
  controlsFound: number;
  viewportFill: boolean;
  /** reset(seed) replay matched under virtual time (null = not run). */
  determinismOk: boolean | null;
  /** Hidden interaction probes (null = overlay unavailable on this run). */
  probesPassed: number | null;
  probesTotal: number | null;
  probesPartial: boolean;
}

export interface UiQualification {
  /** Eligible for the community voting arena. */
  qualified: boolean;
  /** Objective disqualification reasons (empty when qualified). */
  reasons: string[];
  diagnostics: UiDiagnostics;
}

// ---------------------------------------------------------------------------
// Task result (one JSONL journal line)
// ---------------------------------------------------------------------------

export interface UiBenchTaskResult {
  modelId: string;
  displayName: string;
  taskId: string;
  season: number;
  category: UiTaskCategory;
  qualification: UiQualification;
  validation: UiArtifactValidationResult;
  evaluation: Omit<UiArtifactEvaluationResult, 'consoleSample' | 'screenshots' | 'browser'> | null;
  providerResponseMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  success: boolean;
  errorType?: string;
  timestamp: string;
  artifactSha256: string | null;
  artifactPaths: {
    html: string;
    screenshots: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Aggregation and snapshot (v3)
// ---------------------------------------------------------------------------

export interface UiBenchModelSummary {
  modelId: string;
  displayName: string;
  totalTasks: number;
  qualifiedTasks: number;
  disqualifiedTasks: number;
  qualifiedRate: number;
  /** Tasks where every hidden probe passed (badge, not a grade). */
  fullyInteractiveTasks: number;
  probesPartial: boolean;
  totalCostUsd: number;
  averageProviderResponseMs: number;
  byCategory: Record<string, { qualified: number; tasks: number }>;
}

/**
 * The arena roster. Rank/grades come from community Elo (bridgebench-api);
 * the engine only reports eligibility. `elo` stays null in engine snapshots
 * and is filled by the site from the voting API.
 */
export interface UiBenchLeaderboardEntry {
  modelId: string;
  displayName: string;
  qualifiedTasks: number;
  totalTasks: number;
  qualifiedRate: number;
  fullyInteractiveTasks: number;
  elo: number | null;
}

export interface UiBenchSnapshot {
  version: '3.0.0';
  suite: 'ui';
  generatedAt: string;
  season: {
    id: number;
    name: string;
    startsAt: string;
    endsAt: string;
  };
  engine: {
    engineVersion: string;
    threeVersion: string;
    /** Grading is community voting — the engine ships no quality weights. */
    grading: 'community-elo';
  };
  config: {
    totalTasks: number;
    taskIds: string[];
    modelIds: string[];
  };
  roster: UiBenchLeaderboardEntry[];
  models: Record<
    string,
    {
      summary: UiBenchModelSummary;
      results: UiBenchTaskResult[];
    }
  >;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildUiBenchSkipKey(modelId: string, taskId: string): string {
  return `${modelId}::${taskId}`;
}

/** modelId → artifact slug ("openai/gpt-5.4" → "openai--gpt-5.4"). */
export function artifactSlug(modelId: string): string {
  return modelId
    .replace(/\//g, '--')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .toLowerCase();
}
