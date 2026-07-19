import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ArenaRunner } from '../src/arena.js';
import { MockOpenRouterGateway } from '../src/mock-gateway.js';
import { makeTask, withTempStore } from './helpers.js';
import type {
  ChatRequest,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
} from '../src/types.js';
import type { ArenaEvent } from '../src/types.js';

class MockGateway implements OpenRouterGateway {
  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    let content: string;
    if (request.model.role === 'judge') {
      const payload = JSON.parse(request.user) as {
        task: { artifacts: Array<{ id: string }> };
        modelA: { response: string };
        modelB: { response: string };
      };
      const scoreA = Number(payload.modelA.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
      const scoreB = Number(payload.modelB.response.match(/QUALITY=(\d+)/)?.[1] ?? 0);
      content = JSON.stringify({
        winner: scoreA >= scoreB ? 'MODEL_A' : 'MODEL_B',
        confidence: 0.75,
        rationale: 'Selected the more complete mocked response.',
        criteria: {
          correctness: 'Compared.',
          grounding: 'Compared.',
          constraintHandling: 'Compared.',
          completeness: 'Compared.',
        },
        violations: [],
        decisiveDifference: {
          deliverableId: 'd1',
          winnerClaim: 'Reported the higher mocked quality signal.',
          loserError: 'Reported the lower mocked quality signal.',
          artifactIds: [payload.task.artifacts[0]!.id],
          rubricCriterion: 'correctness',
        },
        abstainReason: null,
      });
    } else {
      const quality = [...request.model.id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      content = `QUALITY=${quality}\nConclusion: mocked answer`;
    }
    return {
      generationId: `gen-${request.model.id}`,
      content,
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      latencyMs: 1,
      finishReason: 'stop',
    };
  }
}

describe('arena MVP', () => {
  it('runs a mocked batch from schedule through judgments, Elo, journal, and reports', async () => {
    await withTempStore(async (store) => {
      const events: ArenaEvent[] = [];
      const result = await new ArenaRunner(new MockGateway(), store, (event) =>
        events.push(event),
      ).run(
        {
          category: 'reasoning',
          seed: 'e2e-seed',
          matches: 2,
          maxCostUsd: 5,
          resume: false,
        },
        [makeTask()],
      );
      expect(result).toMatchObject({ completed: 2, stoppedForBudget: false });
      const journal = store.readAll();
      expect(journal).toHaveLength(2);
      expect(
        journal.every((match) => match.outcome === 'judged' && match.panel?.validVotes === 3),
      ).toBe(true);
      const snapshot = JSON.parse(readFileSync(store.config.snapshotPath, 'utf8')) as {
        matches: unknown[];
        leaderboard: Array<{ elo: number }>;
      };
      expect(snapshot.matches).toHaveLength(2);
      expect(snapshot.leaderboard.some((entry) => entry.elo !== 1000)).toBe(true);
      expect(readFileSync(store.config.markdownPath, 'utf8')).toContain(
        'BridgeBench V3 Reasoning Arena',
      );
      expect(events.some((event) => event.type === 'run.started')).toBe(true);
      expect(events.filter((event) => event.type === 'judge.completed')).toHaveLength(6);
      expect(events.filter((event) => event.type === 'match.completed')).toHaveLength(2);
      expect(events.at(-1)?.type).toBe('run.completed');
      // judging.started announces each match's SEATED trio (never the whole
      // pool), and the panel's votes come from exactly those judges.
      for (const match of journal) {
        const started = events.find(
          (event) =>
            event.type === 'judging.started' &&
            (event.data as { matchId: string }).matchId === match.matchId,
        );
        expect(started).toBeDefined();
        const seated = (started!.data as { judges: string[] }).judges;
        expect(seated).toHaveLength(3);
        expect(match.panel?.votes.map((vote) => vote.judgeModelId).sort()).toEqual(
          [...seated].sort(),
        );
        const competitorVendors = new Set(
          [match.competitors.modelA, match.competitors.modelB].map((id) => id.split('/')[0]),
        );
        for (const judgeId of seated) {
          expect(competitorVendors.has(judgeId.split('/')[0]!)).toBe(false);
        }
      }
    });
  });

  it('escalates a split mock panel to best-of-5 through the real mock gateway', async () => {
    // The shipped mock gateway in splitPanel mode varies verdicts per judge,
    // so a 2-1 primary split escalates through the adjudication path exactly
    // as a paid run would — this is the pre-flight demo for arena-v0.5.0.
    await withTempStore(async (store) => {
      const events: ArenaEvent[] = [];
      const result = await new ArenaRunner(
        new MockOpenRouterGateway({ splitPanel: true, chunkDelayMs: 1 }),
        store,
        (event) => events.push(event),
      ).run(
        {
          category: 'reasoning',
          seed: 'escalation-demo-seed',
          matches: 4,
          maxCostUsd: 5,
          resume: false,
        },
        [makeTask()],
      );
      expect(result.completed).toBe(4);
      const journal = store.readAll();
      const escalations = events.filter((event) => event.type === 'judging.escalated');
      const escalated = journal.filter((match) => match.panel && match.panel.votes.length > 3);
      expect(escalated.length).toBeGreaterThan(0);
      expect(escalations.length).toBe(escalated.length);
      for (const match of escalated) {
        const panel = match.panel!;
        expect(panel.adjudicated).toBe(true);
        expect(panel.votes.length).toBeGreaterThanOrEqual(4);
        expect(panel.votes.length).toBeLessThanOrEqual(5);
        // A strict majority of the expanded panel (or no winner at all).
        if (panel.winnerModelId) {
          const majority = Math.floor(panel.votes.length / 2) + 1;
          expect(panel.votesByModel[panel.winnerModelId]).toBeGreaterThanOrEqual(majority);
          expect(match.outcome).toBe('judged');
        } else {
          expect(match.outcome).toBe('no-contest');
        }
        const escalation = escalations.find(
          (event) => (event.data as { matchId: string }).matchId === match.matchId,
        );
        expect(escalation).toBeDefined();
        // Every reserve announced in the event actually voted.
        const voters = new Set(panel.votes.map((vote) => vote.judgeModelId));
        for (const reserve of (escalation!.data as { reserves: string[] }).reserves) {
          expect(voters.has(reserve)).toBe(true);
        }
      }
      // Non-escalated matches keep the classic trio.
      for (const match of journal.filter((entry) => entry.panel?.votes.length === 3)) {
        expect(match.panel!.adjudicated).toBe(false);
      }
    });
  });

  it('health-stops an unhealthy run gracefully with voided matches journaled', async () => {
    class DeadGateway implements OpenRouterGateway {
      async validateModel(_model: ModelRegistryEntry): Promise<void> {}

      async complete(_request: ChatRequest): Promise<ModelCompletion> {
        throw new Error('fetch failed: Premature close');
      }
    }
    await withTempStore(async (store) => {
      const events: string[] = [];
      const runner = new ArenaRunner(new DeadGateway(), store, (event) => events.push(event.type));
      const result = await runner.run(
        {
          category: 'reasoning',
          seed: 'health-stop-seed',
          matches: 12,
          maxCostUsd: 5,
          resume: false,
        },
        [makeTask()],
      );

      // Graceful circuit breaker: no throw, run ends after the threshold with
      // the failed matches journaled as voided no-contests.
      expect(result).toMatchObject({
        completed: 4,
        stoppedForHealth: true,
        stoppedForBudget: false,
        cancelled: false,
      });
      const journaled = store.readAll();
      expect(journaled).toHaveLength(4);
      expect(
        journaled.every(
          (match) =>
            match.outcome === 'no-contest' &&
            match.winnerModelId === null &&
            match.pointAwarded === false,
        ),
      ).toBe(true);
      expect(events).toContain('run.health-stopped');
      expect(events).toContain('run.completed');
      expect(events).not.toContain('run.failed');
    });
  });

  it('runs a doomed batch to completion when the health stop is disabled', async () => {
    class DeadGateway implements OpenRouterGateway {
      async validateModel(_model: ModelRegistryEntry): Promise<void> {}

      async complete(_request: ChatRequest): Promise<ModelCompletion> {
        throw new Error('fetch failed: Premature close');
      }
    }
    await withTempStore(async (store) => {
      const runner = new ArenaRunner(new DeadGateway(), store);
      const result = await runner.run(
        {
          category: 'reasoning',
          seed: 'health-stop-seed',
          matches: 6,
          maxCostUsd: 5,
          resume: false,
          healthStop: false,
        },
        [makeTask()],
      );
      expect(result.completed).toBe(6);
      expect(store.readAll().every((match) => match.outcome === 'no-contest')).toBe(true);
    });
  });
});
