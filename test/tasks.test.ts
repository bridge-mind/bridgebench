import { describe, expect, it } from 'vitest';

import { TaskLoader } from '../src/tasks.js';
import { CATEGORIES, CATEGORY_CLUSTERS } from '../src/types.js';

describe.each(CATEGORIES)('%s task pack', (category) => {
  it('loads 12 balanced tasks with valid evidence', async () => {
    const loader = new TaskLoader(category);
    const tasks = await loader.loadAll();
    expect(tasks).toHaveLength(12);
    const counts = new Map<string, number>();
    for (const task of tasks) {
      expect(task.public.category).toBe(category);
      expect(CATEGORY_CLUSTERS[category]).toContain(task.public.cluster);
      counts.set(task.public.cluster, (counts.get(task.public.cluster) ?? 0) + 1);
    }
    expect(counts.size).toBe(CATEGORY_CLUSTERS[category].length);
    for (const count of counts.values()) expect(count).toBe(2);
    for (const task of tasks) {
      expect(task.publicHash).toMatch(/^[a-f0-9]{64}$/);
      if (loader.hasPrivate) {
        expect(task.privateHash).toMatch(/^[a-f0-9]{64}$/);
      } else {
        expect(task.private).toBeNull();
        expect(task.privateHash).toBeNull();
      }
    }
  });
});

describe('cross-arena isolation', () => {
  it('keeps the two packs disjoint by id and by cluster vocabulary', async () => {
    const [reasoning, hallucination] = await Promise.all([
      new TaskLoader('reasoning').loadAll(),
      new TaskLoader('hallucination').loadAll(),
    ]);
    const reasoningIds = new Set(reasoning.map((task) => task.public.id));
    for (const task of hallucination) expect(reasoningIds.has(task.public.id)).toBe(false);
    const overlap = CATEGORY_CLUSTERS.reasoning.filter((cluster) =>
      (CATEGORY_CLUSTERS.hallucination as readonly string[]).includes(cluster),
    );
    expect(overlap).toHaveLength(0);
  });
});
