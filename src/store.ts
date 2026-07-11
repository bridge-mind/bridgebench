import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ELO_INITIAL } from './elo.js';
import { listModels } from './models.js';
import { findProjectRoot } from './paths.js';
import type { ArenaSnapshot, BenchmarkCategory, EloState, MatchResult } from './types.js';

export interface ArenaStoreConfig {
  category: BenchmarkCategory;
  journalPath: string;
  snapshotPath: string;
  markdownPath: string;
}

/** Each category gets its own results directory — its own journal, Elo ladder, and reports. */
export function categoryStoreConfig(category: BenchmarkCategory): ArenaStoreConfig {
  const root = path.join(findProjectRoot(import.meta.url), 'results', category);
  return {
    category,
    journalPath: path.join(root, 'journal.jsonl'),
    snapshotPath: path.join(root, 'snapshot.json'),
    markdownPath: path.join(root, 'leaderboard.md'),
  };
}

export class ArenaStore {
  constructor(readonly config: ArenaStoreConfig) {
    for (const file of [config.journalPath, config.snapshotPath, config.markdownPath]) {
      mkdirSync(path.dirname(file), { recursive: true });
    }
  }

  get category(): BenchmarkCategory {
    return this.config.category;
  }

  append(result: MatchResult): void {
    appendFileSync(this.config.journalPath, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  readAll(): MatchResult[] {
    if (!existsSync(this.config.journalPath)) return [];
    return readFileSync(this.config.journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line) as MatchResult;
        } catch {
          throw new Error(`Malformed arena journal line ${index + 1}; refusing to continue`);
        }
      });
  }

  completedMatchIds(): Set<string> {
    return new Set(this.readAll().map((result) => result.matchId));
  }

  rebuildEloState(): EloState {
    const ratings = Object.fromEntries(listModels('competitor').map((model) => [model.id, ELO_INITIAL]));
    const points = Object.fromEntries(listModels('competitor').map((model) => [model.id, 0]));
    for (const result of this.readAll()) {
      for (const [modelId, rating] of Object.entries(result.eloAfter)) ratings[modelId] = rating;
      if (result.pointAwarded && result.winnerModelId) points[result.winnerModelId] = (points[result.winnerModelId] ?? 0) + 1;
    }
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
