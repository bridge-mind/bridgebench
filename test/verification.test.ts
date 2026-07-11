import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRunManifest, runIdFromManifest, runManifestHash } from '../src/run-manifest.js';
import { ArenaStore } from '../src/store.js';
import { verifyJournal } from '../src/verification.js';
import { makeTask } from './helpers.js';

function fixtureStore(name: string): ArenaStore {
  const journalPath = path.resolve('test', 'fixtures', 'journals', name);
  return new ArenaStore({
    category: 'reasoning',
    journalPath,
    snapshotPath: `${journalPath}.snapshot`,
    markdownPath: `${journalPath}.md`,
    readOnly: true,
  });
}

describe('journal verification', () => {
  it('replays a valid journal from initial Elo', () => {
    const store = fixtureStore('valid.jsonl');
    const verified = verifyJournal(store.readAll(), 'reasoning', {
      manifestForRun: (runId) => store.readRunManifest(runId),
      requireManifests: true,
    });
    const expected = JSON.parse(
      readFileSync(path.resolve('test', 'fixtures', 'journals', 'expected-ladder.json'), 'utf8'),
    ) as { ratings: Record<string, number>; points: Record<string, number> };
    expect(verified.ratings).toEqual(expected.ratings);
    expect(verified.points).toEqual(expected.points);
    expect(verified.matches).toHaveLength(1);
    expect(verified.warnings).toEqual([]);
  });

  it('rejects a tampered rating at the exact line', () => {
    const store = fixtureStore('tampered-rating.jsonl');
    expect(() => verifyJournal(store.readAll(), 'reasoning')).toThrow(
      /Journal line 1: eloAfter\.fixture\/model-a expected 1016, found 1017/,
    );
  });

  it('derives a stable run identity from all canonical inputs', async () => {
    const tasks = [makeTask()];
    const config = {
      category: 'reasoning' as const,
      seed: 'manifest-test',
      matches: 4,
    };
    const first = createRunManifest(config, tasks);
    const second = createRunManifest(config, [...tasks].reverse());
    expect(runManifestHash(first)).toBe(runManifestHash(second));
    expect(runIdFromManifest(first)).toBe(runIdFromManifest(second));
    expect(runIdFromManifest(createRunManifest({ ...config, seed: 'changed' }, tasks))).not.toBe(
      runIdFromManifest(first),
    );
  });
});
