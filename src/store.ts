import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { ELO_INITIAL } from './elo.js';
import { listModels } from './models.js';
import { findProjectRoot } from './paths.js';
import { canonicalJson, RunManifestSchema, type RunManifest } from './run-manifest.js';
import {
  MatchResultSchema,
  type ArenaSnapshot,
  type BenchmarkCategory,
  type EloState,
  type MatchResult,
} from './types.js';
import { verifyJournal } from './verification.js';

export interface ArenaStoreConfig {
  category: BenchmarkCategory;
  journalPath: string;
  snapshotPath: string;
  markdownPath: string;
  runsDir?: string;
  /** Skip directory creation for read-only verification of external journals. */
  readOnly?: boolean;
}

/** Each category gets its own results directory — its own journal, Elo ladder, and reports. */
export function categoryStoreConfig(
  category: BenchmarkCategory,
  resultsRoot = process.env.BRIDGEBENCH_RESULTS_DIR,
): ArenaStoreConfig {
  const projectRoot = findProjectRoot(import.meta.url);
  const base = resultsRoot
    ? path.resolve(projectRoot, resultsRoot)
    : path.join(projectRoot, 'results');
  const root = path.join(base, category);
  return {
    category,
    journalPath: path.join(root, 'journal.jsonl'),
    snapshotPath: path.join(root, 'snapshot.json'),
    markdownPath: path.join(root, 'leaderboard.md'),
    runsDir: path.join(root, 'runs'),
  };
}

export class ArenaStore {
  constructor(readonly config: ArenaStoreConfig) {
    if (config.readOnly) return;
    for (const file of [config.journalPath, config.snapshotPath, config.markdownPath]) {
      mkdirSync(path.dirname(file), { recursive: true });
    }
    mkdirSync(this.runsDir, { recursive: true });
  }

  get category(): BenchmarkCategory {
    return this.config.category;
  }

  get runsDir(): string {
    return this.config.runsDir ?? path.join(path.dirname(this.config.journalPath), 'runs');
  }

  append(result: MatchResult): void {
    appendFileSync(this.config.journalPath, `${JSON.stringify(result)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  readAll(): MatchResult[] {
    if (!existsSync(this.config.journalPath)) return [];
    return readFileSync(this.config.journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          throw new Error(`Malformed arena journal line ${index + 1}; refusing to continue`);
        }
        const parsed = MatchResultSchema.safeParse(decoded);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const location = issue?.path.length ? ` at ${issue.path.join('.')}` : '';
          throw new Error(
            `Invalid arena journal line ${index + 1}${location}: ${issue?.message ?? 'schema mismatch'}`,
          );
        }
        return parsed.data;
      });
  }

  writeRunManifest(runId: string, manifest: RunManifest): void {
    const validated = RunManifestSchema.parse(manifest);
    const target = path.join(this.runsDir, `${runId}.json`);
    const content = `${canonicalJson(validated)}\n`;
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8');
      if (existing !== content) {
        throw new Error(`Run manifest ${runId} already exists with different inputs`);
      }
      return;
    }
    this.atomicWrite(target, content);
  }

  readRunManifest(runId: string): RunManifest | null {
    const target = path.join(this.runsDir, `${runId}.json`);
    if (!existsSync(target)) return null;
    try {
      return RunManifestSchema.parse(JSON.parse(readFileSync(target, 'utf8')));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid run manifest ${runId}: ${reason}`, { cause: error });
    }
  }

  completedMatchIds(): Set<string> {
    return new Set(this.readAll().map((result) => result.matchId));
  }

  rebuildEloState(): EloState {
    const ratings = Object.fromEntries(
      listModels('competitor').map((model) => [model.id, ELO_INITIAL]),
    );
    const points = Object.fromEntries(listModels('competitor').map((model) => [model.id, 0]));
    const verified = verifyJournal(this.readAll(), this.category, {
      manifestForRun: (runId) => this.readRunManifest(runId),
      requireManifests: true,
    });
    Object.assign(ratings, verified.ratings);
    Object.assign(points, verified.points);
    return { ratings, points };
  }

  writeSnapshot(snapshot: ArenaSnapshot): void {
    this.atomicWrite(this.config.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  writeMarkdown(markdown: string): void {
    this.atomicWrite(this.config.markdownPath, markdown);
  }

  private atomicWrite(target: string, content: string): void {
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  }
}
