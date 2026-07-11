import { createHash } from 'node:crypto';

import {
  METHODOLOGY_VERSION,
  type ArenaTask,
  type BenchmarkCategory,
  type ScheduledMatch,
} from './types.js';

function hashSeed(seed: string): number {
  return Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function stableId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20);
}

type Candidate = { left: string; right: string; taskId: string };
type CandidateScore = readonly [
  maxModelExposure: number,
  totalModelExposure: number,
  taskExposure: number,
  pairExposure: number,
];

function pairKey(candidate: Pick<Candidate, 'left' | 'right'>): string {
  return `${candidate.left}|${candidate.right}`;
}

function candidateScore(
  candidate: Candidate,
  modelExposure: Map<string, number>,
  taskExposure: Map<string, number>,
  pairExposure: Map<string, number>,
): CandidateScore {
  const left = modelExposure.get(candidate.left) ?? 0;
  const right = modelExposure.get(candidate.right) ?? 0;
  return [
    Math.max(left, right),
    left + right,
    taskExposure.get(candidate.taskId) ?? 0,
    pairExposure.get(pairKey(candidate)) ?? 0,
  ];
}

function compareScores(left: CandidateScore, right: CandidateScore): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function scheduleMatches(input: {
  category: BenchmarkCategory;
  seed: string;
  count: number;
  modelIds: string[];
  tasks: ArenaTask[];
  /** Production runs derive this from a versioned run manifest. */
  runId?: string;
}): ScheduledMatch[] {
  if (!Number.isInteger(input.count) || input.count < 1)
    throw new Error('Match count must be a positive integer');
  if (input.modelIds.length < 2) throw new Error('At least two competitor models are required');
  if (new Set(input.modelIds).size !== input.modelIds.length)
    throw new Error('Competitor model IDs must be unique');
  const random = mulberry32(hashSeed(`${input.category}|${input.seed}`));
  const runId =
    input.runId ??
    `run-${stableId([
      METHODOLOGY_VERSION,
      input.category,
      input.seed,
      String(input.count),
      ...[...input.modelIds].sort(),
      ...input.tasks.map((task) => task.publicHash),
    ])}`;
  const modelExposure = new Map(input.modelIds.map((id) => [id, 0]));
  const taskExposure = new Map(input.tasks.map((task) => [task.public.id, 0]));
  const pairExposure = new Map<string, number>();
  const used = new Set<string>();
  const combinations: Candidate[] = [];

  for (let i = 0; i < input.modelIds.length; i += 1) {
    for (let j = i + 1; j < input.modelIds.length; j += 1) {
      for (const task of input.tasks) {
        combinations.push({
          left: input.modelIds[i]!,
          right: input.modelIds[j]!,
          taskId: task.public.id,
        });
      }
    }
  }

  const schedule: ScheduledMatch[] = [];
  for (let index = 0; index < input.count; index += 1) {
    if (used.size === combinations.length) used.clear();
    const candidates = combinations.filter(
      (candidate) => !used.has(`${candidate.left}|${candidate.right}|${candidate.taskId}`),
    );
    candidates.sort((left, right) =>
      compareScores(
        candidateScore(left, modelExposure, taskExposure, pairExposure),
        candidateScore(right, modelExposure, taskExposure, pairExposure),
      ),
    );
    const best = candidates[0]!;
    const bestScore = candidateScore(best, modelExposure, taskExposure, pairExposure);
    const tied = candidates.filter(
      (candidate) =>
        compareScores(
          candidateScore(candidate, modelExposure, taskExposure, pairExposure),
          bestScore,
        ) === 0,
    );
    const selected = tied[Math.floor(random() * tied.length)]!;
    used.add(`${selected.left}|${selected.right}|${selected.taskId}`);
    modelExposure.set(selected.left, modelExposure.get(selected.left)! + 1);
    modelExposure.set(selected.right, modelExposure.get(selected.right)! + 1);
    taskExposure.set(selected.taskId, taskExposure.get(selected.taskId)! + 1);
    const selectedPairKey = pairKey(selected);
    pairExposure.set(selectedPairKey, (pairExposure.get(selectedPairKey) ?? 0) + 1);
    const swap = random() >= 0.5;
    const modelA = swap ? selected.right : selected.left;
    const modelB = swap ? selected.left : selected.right;
    schedule.push({
      id: `match-${stableId([runId, String(index), selected.taskId, modelA, modelB])}`,
      runId,
      index,
      seed: input.seed,
      category: input.category,
      taskId: selected.taskId,
      modelA,
      modelB,
    });
  }
  return schedule;
}
