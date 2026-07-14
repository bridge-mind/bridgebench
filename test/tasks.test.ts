import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import {
  TaskLoader,
  TASKS_PER_CATEGORY,
  TASKS_PER_CLUSTER,
  validatePublicTaskFile,
} from '../src/tasks.js';
import { CATEGORIES, CATEGORY_CLUSTERS, TaskPublicSchema } from '../src/types.js';
import { makePrivateTask, makePublicTask, withTempDir } from './helpers.js';

describe.each(CATEGORIES)('%s task pack', (category) => {
  it('loads a balanced pack with valid evidence', async () => {
    const loader = new TaskLoader(category);
    const tasks = await loader.loadAll();
    expect(tasks).toHaveLength(TASKS_PER_CATEGORY);
    const counts = new Map<string, number>();
    for (const task of tasks) {
      expect(task.public.category).toBe(category);
      expect(CATEGORY_CLUSTERS[category]).toContain(task.public.cluster);
      counts.set(task.public.cluster, (counts.get(task.public.cluster) ?? 0) + 1);
    }
    expect(counts.size).toBe(CATEGORY_CLUSTERS[category].length);
    for (const count of counts.values()) expect(count).toBe(TASKS_PER_CLUSTER);
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

describe('single-task validation', () => {
  it('validates one public task without enforcing pack balance', async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, 'fixture-task.yaml');
      writeFileSync(file, YAML.stringify(makePublicTask()));
      const task = await validatePublicTaskFile(file);
      expect(task.public.id).toBe('fixture-task');
      expect(task.private).toBeNull();
    });
  });

  it('reports filename and duplicate-artifact errors with context', async () => {
    await withTempDir(async (root) => {
      const wrongName = path.join(root, 'wrong-name.yaml');
      writeFileSync(wrongName, YAML.stringify(makePublicTask()));
      await expect(validatePublicTaskFile(wrongName)).rejects.toThrow(
        /must use the task id fixture-task as its filename/,
      );

      const duplicate = path.join(root, 'fixture-task.yaml');
      const task = makePublicTask();
      writeFileSync(
        duplicate,
        YAML.stringify({
          ...task,
          artifacts: [task.artifacts[0], task.artifacts[0]],
        }),
      );
      await expect(validatePublicTaskFile(duplicate)).rejects.toThrow(
        /duplicate artifact ids: fixture-spec/,
      );
    });
  });

  it('rejects every private-only field in a public task', () => {
    for (const field of [
      'expectedResolution',
      'requiredEvidence',
      'disqualifyingErrors',
      'rubric',
    ]) {
      expect(
        TaskPublicSchema.safeParse({
          ...makePublicTask(),
          [field]: field === 'rubric' ? {} : 'private',
        }).success,
        field,
      ).toBe(false);
    }
  });

  it('rejects rendered competitor prompts over the transport limit', async () => {
    await withTempDir(async (root) => {
      const file = path.join(root, 'fixture-task.yaml');
      const task = makePublicTask({
        artifacts: Array.from({ length: 5 }, (_, index) => ({
          id: `artifact-${index}`,
          type: 'code' as const,
          label: `Artifact ${index}`,
          content: 'x'.repeat(40_000),
        })),
      });
      writeFileSync(file, YAML.stringify(task));
      await expect(validatePublicTaskFile(file)).rejects.toThrow(/competitor prompt; limit 180000/);
    });
  });

  it('rejects worst-case judge prompts over the transport limit', async () => {
    await withTempDir(async (root) => {
      const publicDir = path.join(root, 'public');
      const privateDir = path.join(root, 'private');
      mkdirSync(publicDir);
      mkdirSync(privateDir);
      const publicTask = makePublicTask({
        prompt: 'p'.repeat(10_000),
        artifacts: [
          {
            id: 'fixture-spec',
            type: 'spec',
            label: 'Fixture specification',
            content: 'x'.repeat(40_000),
          },
        ],
      });
      const privateTask = makePrivateTask(publicTask, {
        expectedResolution: 'r'.repeat(10_000),
      });
      writeFileSync(path.join(publicDir, 'fixture-task.yaml'), YAML.stringify(publicTask));
      writeFileSync(path.join(privateDir, 'fixture-task.yaml'), YAML.stringify(privateTask));
      await expect(new TaskLoader('reasoning', root, privateDir).loadAll()).rejects.toThrow(
        /worst-case judge prompt; limit 180000/,
      );
    });
  });
});
