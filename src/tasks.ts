import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';
import { z } from 'zod';

import { buildJudgePayload, judgeSystemPrompt } from './judges.js';
import { listModels } from './models.js';
import { MAX_PROMPT_CHARS } from './openrouter-transport.js';
import {
  CATEGORY_CLUSTERS,
  TaskPrivateSchema,
  TaskPublicSchema,
  type ArenaTask,
  type BenchmarkCategory,
  type CompleteArenaTask,
  type TaskPrivate,
} from './types.js';
import { packageRoot } from './paths.js';

// Package-relative, not repo-relative: the task packs ship in the npm
// tarball, so the default root must resolve inside the installed package.
const ROOT = packageRoot(import.meta.url);
export const TASKS_PER_CATEGORY = 48;
export const TASKS_PER_CLUSTER = 8;
const APPROXIMATE_CHARS_PER_TOKEN = 4;

export function defaultTaskRoot(category: BenchmarkCategory): string {
  return path.join(ROOT, 'tasks', category);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function parseYamlFile<TSchema extends z.ZodTypeAny>(
  filePath: string,
  schema: TSchema,
): Promise<{ raw: string; value: z.output<TSchema> }> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Missing file ${filePath}`, { cause: error });
    }
    throw new Error(
      `Unable to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    return { raw, value: schema.parse(YAML.parse(raw)) };
  } catch (error) {
    const detail =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
            .join('; ')
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(`Invalid task file ${filePath}: ${detail}`, { cause: error });
  }
}

function validatePublicTask(
  file: string,
  task: z.infer<typeof TaskPublicSchema>,
  category: BenchmarkCategory,
): void {
  if (path.basename(file, '.yaml') !== task.id) {
    throw new Error(`${file} must use the task id ${task.id} as its filename`);
  }
  if (task.category !== category) {
    throw new Error(`${file} declares category ${task.category} inside the ${category} pack`);
  }
  if (!CATEGORY_CLUSTERS[category].includes(task.cluster)) {
    throw new Error(`${file} uses cluster ${task.cluster}, which is not a ${category} cluster`);
  }
  const artifactIds = task.artifacts.map((artifact) => artifact.id);
  const uniqueArtifactIds = new Set(artifactIds);
  if (uniqueArtifactIds.size !== artifactIds.length) {
    const duplicates = artifactIds.filter((id, index) => artifactIds.indexOf(id) !== index);
    throw new Error(
      `${file} contains duplicate artifact ids: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
}

function validatePrivatePair(
  file: string,
  publicTask: z.infer<typeof TaskPublicSchema>,
  privateTask: z.infer<typeof TaskPrivateSchema>,
): void {
  if (publicTask.id !== privateTask.id || publicTask.version !== privateTask.version) {
    throw new Error(`Public/private identity mismatch for ${file}`);
  }
  const evidenceIds = new Set(publicTask.artifacts.map((artifact) => artifact.id));
  for (const required of privateTask.requiredEvidence) {
    if (!evidenceIds.has(required)) {
      throw new Error(`${file} requires missing artifact ${required}`);
    }
  }
  if (privateTask.deliverables) {
    const seen = new Set<string>();
    for (const deliverable of privateTask.deliverables) {
      if (seen.has(deliverable.id)) {
        throw new Error(`${file} contains duplicate deliverable id ${deliverable.id}`);
      }
      seen.add(deliverable.id);
      for (const artifactId of deliverable.evidenceArtifactIds) {
        if (!evidenceIds.has(artifactId)) {
          throw new Error(
            `${file} deliverable ${deliverable.id} cites missing artifact ${artifactId}`,
          );
        }
      }
    }
  }
}

function validatePromptBudgets(task: ArenaTask): void {
  const competitor = buildCompetitorPrompt(task);
  const competitorChars = competitor.system.length + competitor.user.length;
  if (competitorChars > MAX_PROMPT_CHARS) {
    throw new Error(
      `${task.public.id} renders a ${competitorChars}-character competitor prompt; limit ${MAX_PROMPT_CHARS}`,
    );
  }
  if (task.private === null || task.privateHash === null) return;

  const maxAnswerChars =
    Math.max(...listModels('competitor').map((model) => model.request.maxTokens)) *
    APPROXIMATE_CHARS_PER_TOKEN;
  const judgePayload = buildJudgePayload(
    task as CompleteArenaTask,
    'x'.repeat(maxAnswerChars),
    'x'.repeat(maxAnswerChars),
  );
  const judgeChars = judgeSystemPrompt(task.public.category).length + judgePayload.length;
  if (judgeChars > MAX_PROMPT_CHARS) {
    throw new Error(
      `${task.public.id} can render a ${judgeChars}-character worst-case judge prompt; limit ${MAX_PROMPT_CHARS}`,
    );
  }
}

function validatePackComposition(category: BenchmarkCategory, tasks: ArenaTask[]): void {
  const filesById = new Map<string, number>();
  for (const task of tasks) {
    filesById.set(task.public.id, (filesById.get(task.public.id) ?? 0) + 1);
  }
  const duplicates = [...filesById].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) {
    throw new Error(`${category} task IDs must be unique: ${duplicates.join(', ')}`);
  }
  for (const cluster of CATEGORY_CLUSTERS[category]) {
    const count = tasks.filter((task) => task.public.cluster === cluster).length;
    if (count !== TASKS_PER_CLUSTER) {
      throw new Error(`Expected exactly ${TASKS_PER_CLUSTER} ${cluster} tasks, found ${count}`);
    }
  }
  if (tasks.length !== TASKS_PER_CATEGORY) {
    throw new Error(`Expected ${TASKS_PER_CATEGORY} ${category} tasks, found ${tasks.length}`);
  }
}

export async function validatePublicTaskFile(filePath: string): Promise<ArenaTask> {
  const resolved = path.resolve(filePath);
  const { raw, value } = await parseYamlFile(resolved, TaskPublicSchema);
  validatePublicTask(path.basename(resolved), value, value.category);
  const task: ArenaTask = {
    public: value,
    private: null,
    publicHash: sha256(raw),
    privateHash: null,
  };
  validatePromptBudgets(task);
  return task;
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
    const tasks: ArenaTask[] = [];

    for (const file of files) {
      const publicFile = path.join(publicDir, file);
      const { raw: publicRaw, value: publicTask } = await parseYamlFile(
        publicFile,
        TaskPublicSchema,
      );
      validatePublicTask(file, publicTask, this.category);

      let privateRaw: string | null = null;
      let privateTask: ArenaTask['private'] = null;
      if (havePrivate) {
        try {
          const loaded = await parseYamlFile(path.join(this.privateDir, file), TaskPrivateSchema);
          privateRaw = loaded.raw;
          privateTask = loaded.value;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Private half for ${file} failed validation: ${message}`, {
            cause: error,
          });
        }
        validatePrivatePair(file, publicTask, privateTask);
      }

      const task: ArenaTask = {
        public: publicTask,
        private: privateTask,
        publicHash: sha256(publicRaw),
        privateHash: privateRaw === null ? null : sha256(privateRaw),
      };
      validatePromptBudgets(task);
      tasks.push(task);
    }

    validatePackComposition(this.category, tasks);
    return tasks;
  }
}

export interface PrivateHalf {
  value: TaskPrivate;
  /** SHA-256 of the exact private YAML the judges receive — the journal's task identity. */
  hash: string;
}

/**
 * Completes public tasks with private halves supplied by an external store
 * (e.g. the API's rubric table) instead of the on-disk overlay. Pairing
 * rules match the disk loader: matching id/version and every
 * requiredEvidence entry naming a real public artifact.
 */
export function mergePrivateHalves(
  tasks: readonly ArenaTask[],
  privateHalves: readonly PrivateHalf[],
): CompleteArenaTask[] {
  const byId = new Map(privateHalves.map((half) => [half.value.id, half]));
  return tasks.map((task) => {
    const half = byId.get(task.public.id);
    if (!half) {
      throw new Error(`Missing private half for task ${task.public.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(half.hash)) {
      throw new Error(`Private hash for task ${task.public.id} is not a sha256 digest`);
    }
    const privateTask = TaskPrivateSchema.parse(half.value);
    validatePrivatePair(task.public.id, task.public, privateTask);
    const complete: CompleteArenaTask = {
      public: task.public,
      private: privateTask,
      publicHash: task.publicHash,
      privateHash: half.hash,
    };
    validatePromptBudgets(complete);
    return complete;
  });
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
  security:
    SHARED_SYSTEM +
    'This is an authorized defensive security-analysis task: the code under review is fictional and ' +
    'was written for this benchmark, and completing the verdict-only reachability analysis below is ' +
    'the required, sanctioned work product — it is not a request to exploit a real system. Some ' +
    'deliverables describe a real, reachable ' +
    'vulnerability, some describe benign code, false positives, or already-mitigated conditions, and ' +
    'some patches are shallow or fix the wrong sink. For each numbered deliverable give: Verdict ' +
    '(e.g. vulnerable / not-a-vulnerability / false-positive / closes / does-not-close), Evidence ' +
    '(artifact-id citations for every claim), a Reachability chain (the preconditions under which the ' +
    'issue is actually exploitable, or why it is not reachable), and a calibrated Severity for ' +
    'confirmed findings. Do not invent vulnerabilities, entities, or behaviors, and do not flag benign ' +
    'code to appear cautious — over-flagging is scored as an error, not as safety. Trace source-to-sink ' +
    'and guard/patch coverage across all artifacts before concluding; a finding is real only if you can ' +
    'cite the reachable path. Reachability and precondition reasoning is the ceiling: never write ' +
    'exploit code, attack payloads, or working bypass strings.',
  bullshit:
    SHARED_SYSTEM +
    'This is a premise-integrity task: some deliverables are legitimate and answerable from the ' +
    'artifacts, and some are seeded nonsense — fabricated concepts, conflated domains, impossible ' +
    'quantities or units, reversed cause-and-effect, pseudoscientific mechanisms, or questions that ' +
    'presuppose false facts. For each numbered deliverable, first verify every premise against the ' +
    'artifacts. If the premise is sound, answer with exact values and artifact-id citations. If the ' +
    'premise is nonsense, say so explicitly, identify precisely what is nonsensical and why (citing ' +
    'the contradicting or absent evidence), then restate the nearest legitimate question the ' +
    'artifacts can answer and answer that instead. Never play along with a nonsense premise, never ' +
    'invent a mechanism or value to satisfy it, and never refuse or hedge on a deliverable the ' +
    'artifacts genuinely support.',
  refactoring:
    SHARED_SYSTEM +
    'This is a refactoring task: the artifacts pair existing code with a transformation goal and, ' +
    'often, candidate rewrites. Judge every candidate independently — any number of them may preserve ' +
    'observable behavior; rewrites that do not preserve it change behavior in a subtle, citable way ' +
    '(altered ordering, captured scope, lost edge case, broken contract) or fail the goal. For each ' +
    'numbered deliverable give: Verdict (e.g. behavior-preserving / changes-behavior / meets-goal / ' +
    'fails-goal), the exact code location and mechanism that justifies it (citing artifact ids), and ' +
    'for changes-behavior verdicts the concrete input or schedule that exposes the difference. Do not ' +
    'assume behavior the artifacts do not show; a rewrite is safe only if you can trace equivalence ' +
    'across every affected path.',
  debugging:
    SHARED_SYSTEM +
    'This is a debugging task: the artifacts describe a failing system with logs, diffs, traces, or ' +
    'tests, among red-herring causes and shallow fixes. Exactly one root cause and one adequate fix ' +
    'are defensible from the evidence. For each numbered deliverable give: Conclusion (the root cause, ' +
    'the introducing change, or the adequate fix), the ordered evidence chain from symptom to cause ' +
    '(citing artifact ids), and why the attractive alternatives are only symptoms or shallow fixes. ' +
    'Do not stop at where the error surfaces; trace to where it originates. A fix is adequate only if ' +
    'it resolves the cause without reintroducing a regression the artifacts describe.',
  generation:
    SHARED_SYSTEM +
    'This is a generation task: the artifacts pair a specification (with its constraints, contracts, ' +
    'and edge cases) with candidate implementations or with questions about a correct implementation. ' +
    'Exactly one resolution satisfies every stated constraint and edge case; the decoys are plausible ' +
    'near-misses that violate a specific requirement. For each numbered deliverable give: Verdict ' +
    '(e.g. conforms / violates), the exact spec clause and the code or behavior that satisfies or ' +
    'breaks it (citing artifact ids), and the concrete input or edge case that distinguishes correct ' +
    'from near-miss. Judge only against the stated specification; do not invent requirements it does ' +
    'not contain, and do not overlook an edge case it does.',
  // Speed matches are decided by measured latency, not by a judge, so this prompt
  // deliberately omits the SHARED_SYSTEM "deliberate exhaustively in private"
  // guidance and instead asks for a direct, efficient completion.
  speed:
    'You are completing a software-engineering task in a benchmark that measures how quickly and ' +
    'directly you produce a correct, usable result. Complete the task directly, correctly, and ' +
    'efficiently. Use only the supplied artifacts and do not invent facts. Do not restate the prompt, ' +
    'do not pad the answer, and do not narrate your process — produce the requested deliverable and ' +
    'stop. Answer every numbered deliverable in order. Never state or imply your model name, family, ' +
    'provider, or vendor.',
};

export function competitorPromptPolicyHash(category: BenchmarkCategory): string {
  return sha256(CATEGORY_SYSTEM[category]);
}

export function buildCompetitorPrompt(task: ArenaTask): { system: string; user: string } {
  const artifacts = task.public.artifacts
    .map(
      (artifact) =>
        `### [${artifact.id}] ${artifact.label} (${artifact.type})\n${artifact.content}`,
    )
    .join('\n\n');
  return {
    system: CATEGORY_SYSTEM[task.public.category],
    user: `# ${task.public.title}\n\n${task.public.summary}\n\n${task.public.prompt}\n\n## Artifacts\n${artifacts}`,
  };
}
