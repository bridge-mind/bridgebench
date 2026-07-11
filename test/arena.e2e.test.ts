import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import { ArenaStore } from '../src/store.js';
import { TaskLoader } from '../src/tasks.js';
import { completeForTest } from './helpers.js';
import type { ChatRequest, ModelCompletion, ModelRegistryEntry, OpenRouterGateway } from '../src/types.js';
import type { ArenaEvent } from '../src/types.js';

function testStore(root: string): ArenaStore {
  return new ArenaStore({
    category: 'reasoning',
    journalPath: path.join(root, 'journal.jsonl'),
    snapshotPath: path.join(root, 'snapshot.json'),
    markdownPath: path.join(root, 'leaderboard.md'),
  });
}

class MockGateway implements OpenRouterGateway {
  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    let content: string;
    if (request.model.role === 'judge') {
      const payload = JSON.parse(request.user) as {
        modelA: { response: string };
        modelB: { response: string };
      };
      const scoreA = Number(payload.modelA.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
      const scoreB = Number(payload.modelB.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
      content = JSON.stringify({
        winner: scoreA >= scoreB ? 'MODEL_A' : 'MODEL_B', confidence: 0.75,
        rationale: 'Selected the more complete mocked response.',
        criteria: {
          correctness: 'Compared.', grounding: 'Compared.',
          constraintHandling: 'Compared.', completeness: 'Compared.',
        },
        violations: [],
      });
    } else {
      const quality = [...request.model.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      content = `QUALITY=${quality}\nConclusion: mocked answer`;
    }
    return {
      generationId: `gen-${request.model.id}`, content, inputTokens: 100,
      outputTokens: 50, costUsd: 0.01, latencyMs: 1, finishReason: 'stop',
    };
  }
}

describe('arena MVP', () => {
  it('runs a mocked batch from schedule through judgments, Elo, journal, and reports', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bridgebench-v3-'));
    const store = testStore(root);
    const tasks = (await new TaskLoader('reasoning').loadAll()).map(completeForTest);
    const events: ArenaEvent[] = [];
    const result = await new ArenaRunner(new MockGateway(), store, (event) => events.push(event)).run(
      { category: 'reasoning', seed: 'e2e-seed', matches: 2, maxCostUsd: 5, resume: false },
      tasks,
    );
    expect(result).toMatchObject({ completed: 2, stoppedForBudget: false });
    const journal = store.readAll();
    expect(journal).toHaveLength(2);
    expect(journal.every((match) => match.outcome === 'judged' && match.panel?.validVotes === 3)).toBe(true);
    const snapshot = JSON.parse(readFileSync(store.config.snapshotPath, 'utf8')) as { matches: unknown[]; leaderboard: Array<{ elo: number }> };
    expect(snapshot.matches).toHaveLength(2);
    expect(snapshot.leaderboard.some((entry) => entry.elo !== 1000)).toBe(true);
    expect(readFileSync(store.config.markdownPath, 'utf8')).toContain('BridgeBench V3 Reasoning Arena');
    expect(events.some((event) => event.type === 'run.started')).toBe(true);
    expect(events.filter((event) => event.type === 'judge.completed')).toHaveLength(6);
    expect(events.filter((event) => event.type === 'match.completed')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('run.completed');
  });

  it('halts an unhealthy run instead of journaling a full batch of no-contests', async () => {
    class DeadGateway implements OpenRouterGateway {
      async validateModel(_model: ModelRegistryEntry): Promise<void> {}

      async complete(_request: ChatRequest): Promise<ModelCompletion> {
        throw new Error('fetch failed: Premature close');
      }
    }
    const root = mkdtempSync(path.join(tmpdir(), 'bridgebench-v3-'));
    const store = testStore(root);
    const tasks = (await new TaskLoader('reasoning').loadAll()).map(completeForTest);
    const runner = new ArenaRunner(new DeadGateway(), store);
    await expect(
      runner.run({ category: 'reasoning', seed: 'health-stop-seed', matches: 12, maxCostUsd: 5, resume: false }, tasks),
    ).rejects.toThrow(/Run halted after 4 matches/);
    expect(store.readAll()).toHaveLength(4);
  });

  it('runs a doomed batch to completion when the health stop is disabled', async () => {
    class DeadGateway implements OpenRouterGateway {
      async validateModel(_model: ModelRegistryEntry): Promise<void> {}

      async complete(_request: ChatRequest): Promise<ModelCompletion> {
        throw new Error('fetch failed: Premature close');
      }
    }
    const root = mkdtempSync(path.join(tmpdir(), 'bridgebench-v3-'));
    const store = testStore(root);
    const tasks = (await new TaskLoader('reasoning').loadAll()).map(completeForTest);
    const runner = new ArenaRunner(new DeadGateway(), store);
    const result = await runner.run(
      { category: 'reasoning', seed: 'health-stop-seed', matches: 6, maxCostUsd: 5, resume: false, healthStop: false },
      tasks,
    );
    expect(result.completed).toBe(6);
    expect(store.readAll().every((match) => match.outcome === 'no-contest')).toBe(true);
  });
});
