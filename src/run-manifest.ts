import { createHash } from 'node:crypto';

import { z } from 'zod';

import { judgePromptPolicyHash } from './judges.js';
import { listModels } from './models.js';
import { competitorPromptPolicyHash } from './tasks.js';
import {
  BenchmarkCategorySchema,
  METHODOLOGY_VERSION,
  type ArenaRunConfig,
  type CompleteArenaTask,
  type ModelRegistryEntry,
} from './types.js';
import { ENGINE_VERSION } from './version.js';

export const RUN_MANIFEST_VERSION = '1.0.0';

const ManifestModelSchema = z.object({
  id: z.string().min(1),
  canonicalSlug: z.string().min(1),
  role: z.enum(['competitor', 'judge']),
  request: z.object({
    maxTokens: z.number().int().positive(),
    temperature: z.number().finite(),
    reasoningEffort: z.enum(['high', 'medium', 'low']),
    excludeReasoning: z.boolean(),
    timeoutMs: z.number().int().positive(),
  }),
});

export const RunManifestSchema = z.object({
  version: z.literal(RUN_MANIFEST_VERSION),
  methodologyVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  category: BenchmarkCategorySchema,
  seed: z.string(),
  matches: z.number().int().positive(),
  competitors: z.array(ManifestModelSchema),
  judges: z.array(ManifestModelSchema),
  tasks: z.array(
    z.object({
      id: z.string().min(1),
      version: z.string().min(1),
      publicHash: z.string().min(1),
      privateHash: z.string().min(1),
    }),
  ),
  promptPolicyHashes: z.object({
    competitor: z.string().regex(/^[a-f0-9]{64}$/),
    judge: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

function manifestModel(model: ModelRegistryEntry): z.infer<typeof ManifestModelSchema> {
  return {
    id: model.id,
    canonicalSlug: model.canonicalSlug,
    role: model.role,
    request: { ...model.request },
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function runManifestHash(manifest: RunManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

export function runIdFromManifest(manifest: RunManifest): string {
  return `run-${runManifestHash(manifest).slice(0, 20)}`;
}

export function createRunManifest(
  config: Pick<ArenaRunConfig, 'category' | 'seed' | 'matches'>,
  tasks: CompleteArenaTask[],
): RunManifest {
  const competitors = listModels('competitor')
    .map(manifestModel)
    .sort((left, right) => left.id.localeCompare(right.id));
  const judges = listModels('judge')
    .map(manifestModel)
    .sort((left, right) => left.id.localeCompare(right.id));
  const manifest: RunManifest = {
    version: RUN_MANIFEST_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    engineVersion: ENGINE_VERSION,
    category: config.category,
    seed: config.seed,
    matches: config.matches,
    competitors,
    judges,
    tasks: tasks
      .map((task) => ({
        id: task.public.id,
        version: task.public.version,
        publicHash: task.publicHash,
        privateHash: task.privateHash,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    promptPolicyHashes: {
      competitor: competitorPromptPolicyHash(config.category),
      judge: judgePromptPolicyHash(config.category),
    },
  };
  return RunManifestSchema.parse(manifest);
}
