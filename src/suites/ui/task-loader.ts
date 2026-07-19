/**
 * Loads public task YAML specs from tasks/current/ui/ and, when
 * BRIDGEBENCH_PRIVATE_DIR points at a checkout of bridgebench-private,
 * overlays each task's hidden probes from
 *   $BRIDGEBENCH_PRIVATE_DIR/tasks/current/ui/<taskId>.probes.yaml
 *
 * Public clones run fine without the overlay — interaction scoring is then
 * marked partial in results.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { privateDir, TASKS_DIR } from '../../config.js';
import { UiBenchTaskSchema, UiProbeOverlaySchema, type UiBenchFullTask } from './types.js';

const PUBLIC_UI_TASKS_DIR = path.join(TASKS_DIR, 'ui');

export class UiTaskLoader {
  private cache: UiBenchFullTask[] | null = null;

  constructor(
    private readonly tasksDir: string = PUBLIC_UI_TASKS_DIR,
    private readonly overlayDir: string | null = privateDir()
      ? path.join(privateDir()!, 'tasks', 'current', 'ui')
      : null,
  ) {}

  async loadAll(): Promise<UiBenchFullTask[]> {
    if (this.cache) return this.cache;

    const entries = await fs.readdir(this.tasksDir);
    const yamlFiles = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();

    const tasks: UiBenchFullTask[] = [];
    for (const file of yamlFiles) {
      const raw = parseYaml(await fs.readFile(path.join(this.tasksDir, file), 'utf8'));
      const task = UiBenchTaskSchema.parse(raw);

      if (raw.probes !== undefined) {
        throw new Error(
          `Task ${task.id}: public task files must NOT contain probes — they belong in bridgebench-private.`,
        );
      }

      const overlay = await this.loadOverlay(task.id);
      tasks.push({
        ...task,
        probes: overlay?.probes ?? null,
        scoringOverrides: overlay?.scoringOverrides ?? null,
      });
    }

    this.cache = tasks;
    return tasks;
  }

  async loadById(taskId: string): Promise<UiBenchFullTask> {
    const tasks = await this.loadAll();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(
        `Unknown UI task "${taskId}". Available: ${tasks.map((t) => t.id).join(', ')}`,
      );
    }
    return task;
  }

  hasPrivateOverlay(): boolean {
    return this.overlayDir !== null;
  }

  private async loadOverlay(taskId: string) {
    if (!this.overlayDir) return null;
    const overlayPath = path.join(this.overlayDir, `${taskId}.probes.yaml`);
    try {
      const raw = parseYaml(await fs.readFile(overlayPath, 'utf8'));
      const overlay = UiProbeOverlaySchema.parse(raw);
      if (overlay.id !== taskId) {
        throw new Error(
          `Probe overlay id mismatch: file ${overlayPath} declares id "${overlay.id}"`,
        );
      }
      return overlay;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
