/**
 * True end-to-end `ui run` integration: the default mock gateway streams the
 * golden fixture through extract → normalize → validate → journal, exactly as
 * `bridgebench ui run --mock` does when the API console spawns it. No browser
 * executable is part of the live generation path.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { uiJournalPath, uiSnapshotPath } from '../src/suites/ui/publish.js';
import { UiBenchResultStore } from '../src/suites/ui/result-store.js';
import { runUiBench } from '../src/suites/ui/run.js';

const resultsRoot = mkdtempSync(path.join(tmpdir(), 'ui-run-e2e-'));

afterAll(() => {
  rmSync(resultsRoot, { recursive: true, force: true });
});

describe('ui run --mock end to end (generation only)', () => {
  it(
    'qualifies the golden fixture and journals a complete supervised run',
    { timeout: 180_000 },
    async () => {
      const lines: string[] = [];
      const summary = await runUiBench(
        {
          modelSlugs: ['reference'],
          taskIds: ['s1-lava-lamp-redux'],
          publish: false,
          resume: false,
          dry: false,
          mock: true,
          debug: false,
        },
        { stdout: (line) => lines.push(line), resultsRoot },
      );

      // The supervised stdout contract the API console parses.
      expect(lines[0]).toBe('ui-run scheduled total=1 models=1 tasks=1');
      expect(lines.some((line) => line.includes('QUALIFIED'))).toBe(true);

      expect(summary).toMatchObject({
        completed: 1,
        qualified: 1,
        cancelled: false,
        publishedResults: 0, // mock never publishes
      });

      const store = new UiBenchResultStore({
        journalPath: uiJournalPath(resultsRoot),
        snapshotPath: uiSnapshotPath(resultsRoot),
      });
      const [line] = await store.readJournal();
      expect(line).toMatchObject({
        modelId: 'reference',
        taskId: 's1-lava-lamp-redux',
        success: true,
      });
      expect(line!.qualification.qualified).toBe(true);
      expect(line!.qualification.diagnostics.webglActive).toBeNull();
      // Mock metrics come from the gateway, not hardcoded zeros.
      expect(line!.costUsd).toBeGreaterThan(0);
      expect(line!.outputTokens).toBeGreaterThan(0);
      // The publishable artifact lands on disk without browser screenshots.
      expect(line!.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(existsSync(line!.artifactPaths.html)).toBe(true);
      expect(readFileSync(line!.artifactPaths.html, 'utf8')).toContain(
        'window.BridgeBenchTaskManifest',
      );
      expect(line!.artifactPaths.screenshots).toEqual({});
    },
  );
});
