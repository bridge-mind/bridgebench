/**
 * Journal + snapshot persistence (ported pattern): the append-only JSONL
 * journal is the source of truth and is crash-safe; the snapshot JSON is
 * derived and atomically rebuilt from it. --resume skips (model, task)
 * pairs already successful in the journal.
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

import { buildUiBenchSnapshot } from './aggregator.js';
import {
  buildUiBenchSkipKey,
  type UiBenchSnapshot,
  type UiBenchTaskResult,
} from './types.js';

export interface UiBenchStoreConfig {
  journalPath: string;
  snapshotPath: string;
}

export class UiBenchResultStore {
  private readonly journalPath: string;
  private readonly snapshotPath: string;
  private stream: WriteStream | null = null;

  constructor(config: UiBenchStoreConfig) {
    this.journalPath = config.journalPath;
    this.snapshotPath = config.snapshotPath;

    mkdirSync(dirname(this.journalPath), { recursive: true });
    mkdirSync(dirname(this.snapshotPath), { recursive: true });
  }

  open(): void {
    this.stream = createWriteStream(this.journalPath, { flags: 'a' });
  }

  append(result: UiBenchTaskResult): void {
    if (!this.stream) throw new Error('Store not open');
    this.stream.write(JSON.stringify(result) + '\n');
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stream) return resolve();
      this.stream.end((error: Error | null | undefined) =>
        error ? reject(error) : resolve(),
      );
      this.stream = null;
    });
  }

  async readJournal(): Promise<UiBenchTaskResult[]> {
    if (!existsSync(this.journalPath)) return [];

    const results: UiBenchTaskResult[] = [];
    const reader = createInterface({
      input: createReadStream(this.journalPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        results.push(JSON.parse(trimmed) as UiBenchTaskResult);
      } catch {
        // Ignore malformed lines (e.g. a crash mid-write on the last line).
      }
    }

    return results;
  }

  async buildSkipSet(): Promise<Set<string>> {
    const results = await this.readJournal();
    return new Set(
      results
        .filter((result) => result.success)
        .map((result) => buildUiBenchSkipKey(result.modelId, result.taskId)),
    );
  }

  async rebuildSnapshot(taskIds: string[], modelIds: string[]): Promise<UiBenchSnapshot> {
    const snapshot = buildUiBenchSnapshot(await this.readJournal(), taskIds, modelIds);
    this.writeSnapshot(snapshot);
    return snapshot;
  }

  readSnapshot(): UiBenchSnapshot | null {
    if (!existsSync(this.snapshotPath)) return null;
    try {
      return JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as UiBenchSnapshot;
    } catch {
      return null;
    }
  }

  writeSnapshot(snapshot: UiBenchSnapshot): void {
    const tmpPath = this.snapshotPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    renameSync(tmpPath, this.snapshotPath);
  }

  writeSnapshotCopy(snapshot: UiBenchSnapshot, outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });
    const tmpPath = outputPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
    renameSync(tmpPath, outputPath);
  }
}
