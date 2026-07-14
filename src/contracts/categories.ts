import { z } from 'zod';

export const METHODOLOGY_VERSION = 'arena-v0.3.0';

export const BenchmarkCategorySchema = z.enum([
  'reasoning',
  'hallucination',
  'security',
  'bullshit',
  'refactoring',
  'debugging',
  'generation',
  'speed',
]);
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
  security: [
    'vuln-discovery',
    'taint-flow',
    'authz-boundary',
    'patch-verification',
    'finding-triage',
    'supply-chain',
  ],
  bullshit: [
    'fabricated-concepts',
    'crossed-domains',
    'impossible-quantities',
    'reversed-causality',
    'plausible-pseudoscience',
    'loaded-assumptions',
  ],
  refactoring: [
    'behavior-preservation',
    'extract-and-inline',
    'dependency-decoupling',
    'api-migration',
    'dead-code-elimination',
    'semantic-equivalence',
  ],
  debugging: [
    'root-cause-isolation',
    'regression-introduction',
    'concurrency-defect',
    'state-corruption',
    'error-propagation',
    'fix-adequacy',
  ],
  generation: [
    'spec-conformance',
    'edge-case-coverage',
    'api-contract-adherence',
    'algorithmic-correctness',
    'constraint-satisfaction',
    'interface-compatibility',
  ],
  speed: [
    'short-completion',
    'long-generation',
    'structured-output',
    'code-transformation',
    'stepwise-reasoning',
    'retrieval-synthesis',
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
  security: {
    label: 'Security',
    tagline:
      'Tasks hide one defensible vulnerability among benign look-alikes, false positives, and shallow patches — the arena measures who proves reachable exploitability with evidence instead of crying wolf.',
  },
  bullshit: {
    label: 'BullShit',
    tagline:
      'Tasks seed confident nonsense — fabricated concepts, crossed domains, impossible quantities — among legitimate deliverables; the arena measures who corrects the user instead of fluently answering the unanswerable.',
  },
  refactoring: {
    label: 'Refactoring',
    tagline:
      'Tasks pair code with a transformation goal and candidate rewrites — the arena measures who preserves observable behavior and spots the rewrite that silently changes it.',
  },
  debugging: {
    label: 'Debugging',
    tagline:
      'Tasks supply a failing system and its evidence among red-herring causes and shallow fixes — the arena measures who isolates the one defensible root cause and the fix that actually holds.',
  },
  generation: {
    label: 'Generation',
    tagline:
      'Tasks pair a specification with candidate implementations — the arena measures who identifies the one that meets every constraint and edge case instead of the plausible near-miss.',
  },
  speed: {
    label: 'Speed',
    tagline:
      'Both competitors get the same task and race: no judges, no quality vote. The winner is decided deterministically by measured latency — time to first token and sustained output throughput settle who finishes the work faster.',
  },
};
