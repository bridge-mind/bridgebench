import { createHash } from 'node:crypto';

import type { ArenaTask, CompleteArenaTask, TaskPrivate } from '../src/types.js';

/**
 * The public checkout ships only public task halves; hidden references live
 * in the private overlay (see docs/private-packs.md). Tests that exercise
 * judging synthesize a stand-in reference when the overlay is absent so the
 * suite passes in both setups — the mock gateways never grade against its
 * content.
 */
export function completeForTest(task: ArenaTask): CompleteArenaTask {
  if (task.private !== null && task.privateHash !== null) {
    return task as CompleteArenaTask;
  }
  const synthesized: TaskPrivate = {
    id: task.public.id,
    version: task.public.version,
    expectedResolution: 'Synthesized stand-in reference for offline tests.',
    requiredEvidence: [task.public.artifacts[0]!.id],
    disqualifyingErrors: [],
    rubric: {
      correctness: 'Matches the reference conclusion.',
      evidenceGrounding: 'Cites the artifacts.',
      constraintHandling: 'Applies stated constraints.',
      completeness: 'Answers every deliverable.',
    },
  };
  return {
    ...task,
    private: synthesized,
    privateHash: createHash('sha256').update(JSON.stringify(synthesized)).digest('hex'),
  };
}
