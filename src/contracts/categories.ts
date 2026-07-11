import { z } from 'zod';

export const METHODOLOGY_VERSION = 'arena-v0.3.0';

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
