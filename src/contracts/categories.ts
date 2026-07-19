import { z } from 'zod';

export const METHODOLOGY_VERSION = 'arena-v0.6.0';

/**
 * Methodology versions whose journals remain importable and verifiable.
 * arena-v0.3.0 is the fixed three-judge-panel era; arena-v0.4.0 seats each
 * match's panel from the judge pool (deterministic rotation with vendor
 * conflict-of-interest exclusion — see seating.ts); arena-v0.5.0 adds
 * TIE/ABSTAIN verdicts, typed decisive differences, and best-of-5 adaptive
 * adjudication on contested panels; arena-v0.6.0 splits ranked from
 * exhibition runs — exhibition matches are judged and journaled but never
 * move Elo (eloAfter must equal eloBefore). Validators gate panel membership
 * and verdict rules on the journal line's version, so historical re-imports
 * keep working forever.
 */
export const SUPPORTED_IMPORT_METHODOLOGY_VERSIONS = [
  'arena-v0.3.0',
  'arena-v0.4.0',
  'arena-v0.5.0',
  METHODOLOGY_VERSION,
] as const;

/**
 * True for methodology versions that carry the ranked/exhibition split.
 * Earlier journal lines have no `ranked` field and every match moves Elo.
 */
export function supportsExhibitionMatches(methodologyVersion: string): boolean {
  return (
    methodologyVersion !== 'arena-v0.3.0' &&
    methodologyVersion !== 'arena-v0.4.0' &&
    methodologyVersion !== 'arena-v0.5.0'
  );
}

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
    // Honest label for the construct: nothing is executed, so the arena
    // measures conformance analysis against a written spec, not codegen.
    label: 'Spec Conformance',
    tagline:
      'Tasks pair a specification with candidate implementations — nothing is executed; the arena measures who verifies clause-by-clause conformance and spots the plausible near-miss.',
  },
  speed: {
    label: 'Speed',
    tagline:
      'Both competitors get the same task and race: no judges, no quality vote. Each side runs three paired trials and the median total completion time decides the winner deterministically; exact ties void the match, and time to first token and output throughput are recorded alongside for context.',
  },
};
