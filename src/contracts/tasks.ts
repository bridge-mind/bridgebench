import { z } from 'zod';

import { BenchmarkCategorySchema } from './categories.js';

export const TaskArtifactSchema = z
  .object({
    id: z.string().min(1).max(80),
    type: z.enum(['code', 'log', 'config', 'spec', 'diff', 'table', 'note']),
    label: z.string().min(1).max(160),
    content: z.string().min(1).max(40_000),
  })
  .strict();
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>;

export const TaskPublicSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,79}$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    category: BenchmarkCategorySchema,
    cluster: z.string().min(1).max(60),
    difficulty: z.enum(['hard', 'expert']),
    title: z.string().min(1).max(180),
    summary: z.string().min(1).max(500),
    prompt: z.string().min(1).max(10_000),
    artifacts: z.array(TaskArtifactSchema).min(1).max(20),
    tags: z.array(z.string().min(1).max(60)).default([]),
  })
  .strict();
export type TaskPublic = z.infer<typeof TaskPublicSchema>;

/**
 * The closed set of ground-truth labels a structured deliverable may carry.
 * One vocabulary across categories keeps judge verdicts machine-comparable:
 * security uses real-vulnerability / false-positive / mitigated / benign,
 * refactoring uses behavior-preserving / changes-behavior / meets-goal /
 * fails-goal, hallucination uses supported / unsupported / conflicting,
 * bullshit uses legitimate / nonsense, and determinable / underdetermined
 * covers reasoning, debugging, and generation deliverables.
 */
export const DELIVERABLE_CLASSIFICATIONS = [
  'determinable',
  'underdetermined',
  'supported',
  'unsupported',
  'conflicting',
  'real-vulnerability',
  'false-positive',
  'mitigated',
  'benign',
  'legitimate',
  'nonsense',
  'behavior-preserving',
  'changes-behavior',
  'meets-goal',
  'fails-goal',
] as const;
export type DeliverableClassification = (typeof DELIVERABLE_CLASSIFICATIONS)[number];

/**
 * A machine-readable rubric row for one numbered deliverable of a task.
 * Prose fields (expectedResolution, disqualifyingErrors) stay authoritative
 * for tasks that predate structured deliverables; when a task carries
 * deliverables, every judge decisiveDifference must reference one of these
 * IDs, and each evidence artifact ID must resolve against the public task.
 */
export const TaskDeliverableSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    classification: z.enum(DELIVERABLE_CLASSIFICATIONS),
    expectedAnswer: z.string().min(1).max(4_000),
    evidenceArtifactIds: z.array(z.string().min(1).max(80)).min(1).max(10),
    disqualifiers: z.array(z.string().min(1).max(500)).default([]),
    weight: z.number().positive().max(10).default(1),
  })
  .strict();
export type TaskDeliverable = z.infer<typeof TaskDeliverableSchema>;

export const TaskPrivateSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    expectedResolution: z.string().min(1).max(10_000),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    disqualifyingErrors: z.array(z.string().min(1)).default([]),
    /**
     * Structured per-deliverable rubric. Optional while packs migrate from
     * prose; present means decisive differences are validated against it.
     */
    deliverables: z.array(TaskDeliverableSchema).min(1).max(20).optional(),
    rubric: z
      .object({
        correctness: z.string().min(1),
        evidenceGrounding: z.string().min(1),
        constraintHandling: z.string().min(1),
        completeness: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type TaskPrivate = z.infer<typeof TaskPrivateSchema>;

export interface ArenaTask {
  public: TaskPublic;
  /** Null when loaded without a private overlay. */
  private: TaskPrivate | null;
  publicHash: string;
  privateHash: string | null;
}

/** A task whose hidden reference is present — required for judged matches. */
export type CompleteArenaTask = ArenaTask & {
  private: TaskPrivate;
  privateHash: string;
};

/** Narrow a task to one carrying its hidden reference (present for every judged category). */
export function isCompleteArenaTask(task: ArenaTask): task is CompleteArenaTask {
  return task.private !== null && task.privateHash !== null;
}
