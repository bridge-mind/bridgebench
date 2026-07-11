import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import {
  CATEGORY_CLUSTERS,
  TaskPrivateSchema,
  TaskPublicSchema,
  type ArenaTask,
  type BenchmarkCategory,
  type CompleteArenaTask,
} from './types.js';
import { findProjectRoot } from './paths.js';

const ROOT = findProjectRoot(import.meta.url);
export const TASKS_PER_CATEGORY = 12;
export const TASKS_PER_CLUSTER = 2;

export function defaultTaskRoot(category: BenchmarkCategory): string {
  return path.join(ROOT, 'tasks', category);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class TaskLoader {
  private readonly root: string;
  private readonly privateDir: string;

  constructor(
    readonly category: BenchmarkCategory,
    root?: string,
    privateRoot?: string,
  ) {
    this.root = root ?? defaultTaskRoot(category);
    // Hidden references resolve, in order: explicit argument, the
    // BRIDGEBENCH_PRIVATE_DIR overlay (a checkout mirroring this repo's
    // tasks/ layout), then a repo-local private/ directory. The public repo
    // ships public halves only, so the local directory exists only in
    // maintainer setups.
    const overlay = process.env.BRIDGEBENCH_PRIVATE_DIR;
    this.privateDir =
      privateRoot ??
      (overlay
        ? path.join(overlay, 'tasks', category, 'private')
        : path.join(this.root, 'private'));
  }

  get hasPrivate(): boolean {
    return existsSync(this.privateDir);
  }

  async loadAll(options: { requirePrivate: true }): Promise<CompleteArenaTask[]>;
  async loadAll(options?: { requirePrivate?: boolean }): Promise<ArenaTask[]>;
  async loadAll(options?: { requirePrivate?: boolean }): Promise<ArenaTask[]> {
    const publicDir = path.join(this.root, 'public');
    const havePrivate = this.hasPrivate;
    if (options?.requirePrivate && !havePrivate) {
      throw new Error(
        `The ${this.category} pack's hidden references are not available at ${this.privateDir}. ` +
          'Judged matches need them: point BRIDGEBENCH_PRIVATE_DIR at a private-pack checkout ' +
          '(see docs/private-packs.md). Public halves alone support tasks validate, report, and triage.',
      );
    }
    const files = (await readdir(publicDir)).filter((file) => file.endsWith('.yaml')).sort();
    const clusters = CATEGORY_CLUSTERS[this.category];
    const tasks: ArenaTask[] = [];

    for (const file of files) {
      const publicRaw = await readFile(path.join(publicDir, file), 'utf8');
      const publicTask = TaskPublicSchema.parse(YAML.parse(publicRaw));
      if (publicTask.category !== this.category) {
        throw new Error(`${file} declares category ${publicTask.category} inside the ${this.category} pack`);
      }
      if (!clusters.includes(publicTask.cluster)) {
        throw new Error(`${file} uses cluster ${publicTask.cluster}, which is not a ${this.category} cluster`);
      }

      let privateRaw: string | null = null;
      let privateTask: ArenaTask['private'] = null;
      if (havePrivate) {
        try {
          privateRaw = await readFile(path.join(this.privateDir, file), 'utf8');
        } catch {
          throw new Error(`Missing private half for ${file} in ${this.privateDir}`);
        }
        privateTask = TaskPrivateSchema.parse(YAML.parse(privateRaw));
        if (publicTask.id !== privateTask.id || publicTask.version !== privateTask.version) {
          throw new Error(`Public/private identity mismatch for ${file}`);
        }
        const evidenceIds = new Set(publicTask.artifacts.map((artifact) => artifact.id));
        for (const required of privateTask.requiredEvidence) {
          if (!evidenceIds.has(required)) throw new Error(`${file} requires missing artifact ${required}`);
        }
      }

      tasks.push({
        public: publicTask,
        private: privateTask,
        publicHash: sha256(publicRaw),
        privateHash: privateRaw === null ? null : sha256(privateRaw),
      });
    }

    const ids = new Set(tasks.map((task) => task.public.id));
    if (ids.size !== tasks.length) throw new Error(`${this.category} task IDs must be unique`);
    for (const cluster of clusters) {
      const count = tasks.filter((task) => task.public.cluster === cluster).length;
      if (count !== TASKS_PER_CLUSTER) {
        throw new Error(`Expected exactly ${TASKS_PER_CLUSTER} ${cluster} tasks, found ${count}`);
      }
    }
    if (tasks.length !== TASKS_PER_CATEGORY) {
      throw new Error(`Expected ${TASKS_PER_CATEGORY} ${this.category} tasks, found ${tasks.length}`);
    }
    return tasks;
  }
}

const SHARED_SYSTEM =
  'You are competing in a software-engineering benchmark. Solve the task independently. ' +
  'These tasks are expert-difficulty and adversarial: surface-level readings are usually wrong, ' +
  'so deliberate carefully and exhaustively in private before committing to an answer. ' +
  'Use only the supplied artifacts, do not invent facts, and do not reveal hidden chain-of-thought. ' +
  'Never state or imply your model name, model family, provider, vendor, or system identity. ' +
  'Answer every numbered deliverable in order; do not skip or merge parts. ';

const CATEGORY_SYSTEM: Record<BenchmarkCategory, string> = {
  reasoning:
    SHARED_SYSTEM +
    'This is a reasoning task: every deliverable has exactly one defensible resolution derivable ' +
    'from the artifacts. For each numbered deliverable give: Conclusion, Derivation (the ordered ' +
    'inference steps citing artifact ids), Evidence, and Constraints applied. Vague hedging on a ' +
    'determinable question is treated as a wrong answer.',
  hallucination:
    SHARED_SYSTEM +
    'This is a grounding task: some deliverables are answerable from the artifacts, some rest on a ' +
    'false premise, and some are not determinable from the supplied material. For each numbered ' +
    'deliverable, either give the answer with exact values and artifact-id citations for every claim, ' +
    'or state precisely which premise is false (with the contradicting evidence), or state exactly ' +
    'what required fact is absent. Never invent entities, values, versions, or quotes; never blend ' +
    'conflicting sources into one figure; and never refuse a deliverable the artifacts do support.',
};

export function buildCompetitorPrompt(task: ArenaTask): { system: string; user: string } {
  const artifacts = task.public.artifacts
    .map((artifact) => `### [${artifact.id}] ${artifact.label} (${artifact.type})\n${artifact.content}`)
    .join('\n\n');
  return {
    system: CATEGORY_SYSTEM[task.public.category],
    user: `# ${task.public.title}\n\n${task.public.summary}\n\n${task.public.prompt}\n\n## Artifacts\n${artifacts}`,
  };
}
