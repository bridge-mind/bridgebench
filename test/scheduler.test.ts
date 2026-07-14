import { describe, expect, it } from 'vitest';

import { listModels, SOL_FABLE_PILOT_COMPETITOR_IDS } from '../src/models.js';
import { scheduleMatches } from '../src/scheduler.js';
import { TaskLoader, TASKS_PER_CATEGORY } from '../src/tasks.js';
import { makeTask } from './helpers.js';

describe('seeded match scheduler', () => {
  it('is reproducible, balanced, and avoids duplicate pair/task combinations', async () => {
    const tasks = Array.from({ length: 12 }, (_, index) =>
      makeTask({ id: `fixture-task-${index}` }),
    );
    const modelIds = listModels('competitor').map((model) => model.id);
    const first = scheduleMatches({
      category: 'reasoning',
      seed: 'repeatable',
      count: 24,
      modelIds,
      tasks,
    });
    const second = scheduleMatches({
      category: 'reasoning',
      seed: 'repeatable',
      count: 24,
      modelIds,
      tasks,
    });
    expect(first).toEqual(second);
    expect(first.every((match) => match.modelA !== match.modelB)).toBe(true);
    expect(
      new Set(
        first.map((match) => [match.modelA, match.modelB].sort().join('|') + `|${match.taskId}`),
      ).size,
    ).toBe(24);
    const exposure = Object.fromEntries(modelIds.map((id) => [id, 0]));
    for (const match of first) {
      exposure[match.modelA] = (exposure[match.modelA] ?? 0) + 1;
      exposure[match.modelB] = (exposure[match.modelB] ?? 0) + 1;
    }
    expect(
      Math.max(...Object.values(exposure)) - Math.min(...Object.values(exposure)),
    ).toBeLessThanOrEqual(1);
  });

  it('uses every reasoning task exactly once for the Sol/Fable pilot', async () => {
    const tasks = await new TaskLoader('reasoning').loadAll();
    const schedule = scheduleMatches({
      category: 'reasoning',
      seed: 'sol-fable-pilot',
      count: TASKS_PER_CATEGORY,
      modelIds: [...SOL_FABLE_PILOT_COMPETITOR_IDS],
      tasks,
    });

    expect(schedule).toHaveLength(TASKS_PER_CATEGORY);
    expect(new Set(schedule.map((match) => match.taskId))).toEqual(
      new Set(tasks.map((task) => task.public.id)),
    );
    expect(
      schedule.every(
        (match) =>
          new Set([match.modelA, match.modelB]).size === 2 &&
          [match.modelA, match.modelB].every((modelId) =>
            SOL_FABLE_PILOT_COMPETITOR_IDS.includes(
              modelId as (typeof SOL_FABLE_PILOT_COMPETITOR_IDS)[number],
            ),
          ),
      ),
    ).toBe(true);
  });
});
