import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT } from '../src/config.js';
import { uiJournalPath } from '../src/suites/ui/publish.js';
import { UiBenchResultStore } from '../src/suites/ui/result-store.js';
import {
  defaultLiveUiRunKey,
  runUiBench,
  shouldPublishUiResults,
  UI_RUN_KEY_PATTERN,
} from '../src/suites/ui/run.js';
import type { ModelCompletion, OpenRouterGateway } from '../src/types.js';

const GOLDEN_HTML = readFileSync(path.join(REPO_ROOT, 'fixtures', 'golden-correct.html'), 'utf8');

const apiConfig = {
  baseUrl: 'http://127.0.0.1:8083',
  adminKey: 'test-admin-key',
  timeoutMs: 1_000,
};

function completion(content: string): ModelCompletion {
  return {
    generationId: 'gen-1',
    content,
    inputTokens: 100,
    outputTokens: 5_000,
    costUsd: 0.05,
    latencyMs: 1_500,
    finishReason: 'stop',
    attempts: 1,
  };
}

function goldenGateway(onComplete?: () => void): OpenRouterGateway {
  return {
    complete: async () => {
      onComplete?.();
      return completion(GOLDEN_HTML);
    },
    validateModel: async () => {},
  };
}

function importOk(): Response {
  return new Response(
    JSON.stringify({ importedResults: 1, skippedResults: 0, importedArtifacts: 1 }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

let tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ui-run-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('run identity', () => {
  it('derives ui-s<season>-<yyyymmdd> and matches the API run-key contract', () => {
    const key = defaultLiveUiRunKey(new Date('2026-07-15T12:00:00Z'));
    expect(key).toBe('ui-s1-20260715');
    expect(UI_RUN_KEY_PATTERN.test(key)).toBe(true);
  });

  it('never publishes mock results', () => {
    expect(shouldPublishUiResults(true, true)).toBe(false);
    expect(shouldPublishUiResults(false, true)).toBe(true);
    expect(shouldPublishUiResults(false, false)).toBe(false);
  });
});

describe('runUiBench', () => {
  it('emits the supervised scheduled line first and journals one line per pair', async () => {
    const root = tempRoot();
    const lines: string[] = [];
    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one', 'acme/two'],
        publish: false,
        resume: false,
        // Default/live mode is generation-only and must not need a browser.
        dry: false,
        mock: false,
        debug: false,
      },
      { stdout: (line) => lines.push(line), gateway: goldenGateway(), resultsRoot: root },
    );

    expect(lines[0]).toBe('ui-run scheduled total=2 models=2 tasks=1');
    expect(summary).toMatchObject({ completed: 2, skipped: 0, cancelled: false });
    expect(summary.qualified).toBe(2);
    expect(summary.costUsd).toBeCloseTo(0.1);

    const store = new UiBenchResultStore({
      journalPath: uiJournalPath(root),
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    const journal = await store.readJournal();
    expect(journal).toHaveLength(2);
    expect(journal.map((line) => line.modelId)).toEqual(['acme/one', 'acme/two']);
    expect(journal[0]).toMatchObject({ costUsd: 0.05, inputTokens: 100, outputTokens: 5_000 });
  });

  it('skips pairs already successful in the journal with --resume', async () => {
    const root = tempRoot();
    // Seed a successful line for (acme/one, s1-lava-lamp-redux).
    await runUiBench(
      {
        modelSlugs: ['acme/one'],
        publish: false,
        resume: false,
        dry: true,
        mock: false,
        debug: false,
      },
      { stdout: () => {}, gateway: goldenGateway(), resultsRoot: root },
    );
    const store = new UiBenchResultStore({
      journalPath: uiJournalPath(root),
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    const [seeded] = await store.readJournal();
    store.open();
    store.append({ ...seeded!, success: true });
    await store.close();

    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one'],
        publish: false,
        resume: true,
        dry: true,
        mock: false,
        debug: false,
      },
      { stdout: () => {}, gateway: goldenGateway(), resultsRoot: root },
    );
    expect(summary).toMatchObject({ completed: 0, skipped: 1 });
  });

  it('streams each result to the API and sweeps failed publishes with identical bytes', async () => {
    const root = tempRoot();
    const bodies: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls += 1;
        bodies.push(init?.body as string);
        // First POST (acme/one) fails; everything else succeeds. The sweep
        // must resend acme/one byte-identically after the loop.
        if (calls === 1) return new Response('boom', { status: 500 });
        return importOk();
      }),
    );

    const lines: string[] = [];
    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one', 'acme/two'],
        publish: true,
        runKey: 'ui-test-20260715',
        resume: false,
        dry: true,
        mock: false,
        debug: false,
      },
      {
        stdout: (line) => lines.push(line),
        gateway: goldenGateway(),
        resolveApiConfig: () => apiConfig,
        resultsRoot: root,
      },
    );

    expect(summary).toMatchObject({
      completed: 2,
      publishedResults: 2,
      publishFailures: 0,
      publishConflicts: 0,
      runKey: 'ui-test-20260715',
    });
    // POST 1: acme/one (fails), POST 2: acme/two, POST 3: sweep retry of acme/one.
    expect(calls).toBe(3);
    expect(bodies[2]).toBe(bodies[0]);
    expect(lines.some((line) => line.includes('publish failed (will retry at end)'))).toBe(true);
    expect(JSON.parse(bodies[0]!).run).toMatchObject({ runKey: 'ui-test-20260715', season: 1 });
  });

  it('records 409 conflicts without retrying them', async () => {
    const root = tempRoot();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('conflict', { status: 409 })),
    );
    const lines: string[] = [];
    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one'],
        publish: true,
        runKey: 'ui-test-20260715',
        resume: false,
        dry: true,
        mock: false,
        debug: false,
      },
      {
        stdout: (line) => lines.push(line),
        gateway: goldenGateway(),
        resolveApiConfig: () => apiConfig,
        resultsRoot: root,
      },
    );
    expect(summary).toMatchObject({ publishConflicts: 1, publishFailures: 0, publishedResults: 0 });
    expect(lines.some((line) => line.includes('fresh --run-key'))).toBe(true);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  it('streams the golden fixture through the default mock gateway without mangling it', async () => {
    const root = tempRoot();
    // No injected gateway: exercises MockOpenRouterGateway's chunked stream.
    // Regression: `.{1,24}` chunking dropped newlines, so a `//` comment
    // swallowed the harness-globals script and the fixture disqualified.
    await runUiBench(
      {
        modelSlugs: ['reference'],
        publish: false,
        resume: false,
        dry: true,
        mock: true,
        debug: false,
      },
      { stdout: () => {}, resultsRoot: root },
    );
    const store = new UiBenchResultStore({
      journalPath: uiJournalPath(root),
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    const [line] = await store.readJournal();
    expect(line!.validation.valid).toBe(true);
    const artifact = readFileSync(line!.artifactPaths.html, 'utf8');
    expect(artifact).toContain('\n');
    expect(artifact).toContain('window.BridgeBenchTaskManifest');
  });

  it('force-disables publishing for mock runs', async () => {
    const root = tempRoot();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one'],
        publish: true,
        resume: false,
        dry: true,
        mock: true,
        debug: false,
      },
      {
        stdout: () => {},
        // The mock gateway is the default, but injecting keeps the test hermetic.
        gateway: goldenGateway(),
        resolveApiConfig: () => {
          throw new Error('resolveApiConfig must not be called for mock runs');
        },
        resultsRoot: root,
      },
    );
    expect(summary.publishedResults).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stops between pairs on cancellation and keeps completed results journaled', async () => {
    const root = tempRoot();
    const controller = new AbortController();
    const summary = await runUiBench(
      {
        modelSlugs: ['acme/one', 'acme/two'],
        publish: false,
        resume: false,
        dry: true,
        mock: false,
        debug: false,
      },
      {
        stdout: () => {},
        // Abort after the first completion returns: pair 1 lands, pair 2 must not start.
        gateway: goldenGateway(() => controller.abort()),
        signal: controller.signal,
        resultsRoot: root,
      },
    );
    expect(summary).toMatchObject({ completed: 1, cancelled: true });
    const store = new UiBenchResultStore({
      journalPath: uiJournalPath(root),
      snapshotPath: path.join(root, 'snapshot.json'),
    });
    expect(await store.readJournal()).toHaveLength(1);
  });
});
