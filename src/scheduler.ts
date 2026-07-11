import { createHash } from 'node:crypto';

import { METHODOLOGY_VERSION, type ArenaTask, type BenchmarkCategory, type ScheduledMatch } from './types.js';

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

export function scheduleMatches(input: {
  category: BenchmarkCategory;
  seed: string;
  count: number;
  modelIds: string[];
  tasks: ArenaTask[];
}): ScheduledMatch[] {
  if (!Number.isInteger(input.count) || input.count < 1) throw new Error('Match count must be a positive integer');
  if (input.modelIds.length < 2) throw new Error('At least two competitor models are required');
  if (new Set(input.modelIds).size !== input.modelIds.length) throw new Error('Competitor model IDs must be unique');
  const random = mulberry32(hashSeed(`${input.category}|${input.seed}`));
  const runId = `run-${stableId([METHODOLOGY_VERSION, input.category, input.seed, String(input.count), ...input.tasks.map((t) => t.publicHash)])}`;
  const modelExposure = new Map(input.modelIds.map((id) => [id, 0]));
  const taskExposure = new Map(input.tasks.map((task) => [task.public.id, 0]));
  const pairExposure = new Map<string, number>();
  const used = new Set<string>();
  const combinations: Array<{ left: string; right: string; taskId: string }> = [];

  for (let i = 0; i < input.modelIds.length; i += 1) {
    for (let j = i + 1; j < input.modelIds.length; j += 1) {
      for (const task of input.tasks) {
        combinations.push({ left: input.modelIds[i]!, right: input.modelIds[j]!, taskId: task.public.id });
      }
    }
  }

  const schedule: ScheduledMatch[] = [];
  for (let index = 0; index < input.count; index += 1) {
    if (used.size === combinations.length) used.clear();
    const candidates = combinations.filter((candidate) => !used.has(`${candidate.left}|${candidate.right}|${candidate.taskId}`));
    candidates.sort((a, b) => {
      const aMax = Math.max(modelExposure.get(a.left)!, modelExposure.get(a.right)!);
      const bMax = Math.max(modelExposure.get(b.left)!, modelExposure.get(b.right)!);
      const aSum = modelExposure.get(a.left)! + modelExposure.get(a.right)!;
      const bSum = modelExposure.get(b.left)! + modelExposure.get(b.right)!;
      const aPair = pairExposure.get(`${a.left}|${a.right}`) ?? 0;
      const bPair = pairExposure.get(`${b.left}|${b.right}`) ?? 0;
      return aMax - bMax || aSum - bSum || taskExposure.get(a.taskId)! - taskExposure.get(b.taskId)! || aPair - bPair;
    });
    const best = candidates[0]!;
    const bestScore = [
      Math.max(modelExposure.get(best.left)!, modelExposure.get(best.right)!),
      modelExposure.get(best.left)! + modelExposure.get(best.right)!,
      taskExposure.get(best.taskId)!,
      pairExposure.get(`${best.left}|${best.right}`) ?? 0,
    ].join('|');
    const tied = candidates.filter((candidate) =>
      [
        Math.max(modelExposure.get(candidate.left)!, modelExposure.get(candidate.right)!),
        modelExposure.get(candidate.left)! + modelExposure.get(candidate.right)!,
        taskExposure.get(candidate.taskId)!,
        pairExposure.get(`${candidate.left}|${candidate.right}`) ?? 0,
      ].join('|') === bestScore,
    );
    const selected = tied[Math.floor(random() * tied.length)]!;
    used.add(`${selected.left}|${selected.right}|${selected.taskId}`);
    modelExposure.set(selected.left, modelExposure.get(selected.left)! + 1);
    modelExposure.set(selected.right, modelExposure.get(selected.right)! + 1);
    taskExposure.set(selected.taskId, taskExposure.get(selected.taskId)! + 1);
    const pairKey = `${selected.left}|${selected.right}`;
    pairExposure.set(pairKey, (pairExposure.get(pairKey) ?? 0) + 1);
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
