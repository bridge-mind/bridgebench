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

export const TaskPrivateSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1),
    expectedResolution: z.string().min(1).max(10_000),
    requiredEvidence: z.array(z.string().min(1)).min(1),
    disqualifyingErrors: z.array(z.string().min(1)).default([]),
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
