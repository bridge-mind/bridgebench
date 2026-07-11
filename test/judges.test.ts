import { describe, expect, it } from 'vitest';

import { JudgePanel } from '../src/judges.js';
import { listModels } from '../src/models.js';
import { FixtureGateway, makeCompletion, makeSuccess, makeTask, makeVote } from './helpers.js';
import type {
  ChatRequest,
  CompetitorSuccess,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
  ScheduledMatch,
} from '../src/types.js';

function completion(content: string): ModelCompletion {
  return {
    generationId: 'gen-test',
    content,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.001,
    latencyMs: 5,
    finishReason: 'stop',
  };
}

class JudgeGateway implements OpenRouterGateway {
  requests: ChatRequest[] = [];

  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const payload = JSON.parse(request.user) as {
      modelA: { label: string; response: string };
      modelB: { label: string; response: string };
    };
    const winner = payload.modelA.response.includes('CORRECT') ? 'MODEL_A' : 'MODEL_B';
    return completion(
      JSON.stringify({
        winner,
        confidence: 0.9,
        rationale: 'The selected response matches the reference.',
        criteria: {
          correctness: 'Correct conclusion.',
          grounding: 'Uses evidence.',
          constraintHandling: 'Applies constraints.',
          completeness: 'Answers every part.',
        },
        violations: [],
      }),
    );
  }
}

function response(modelId: string, content: string): CompetitorSuccess {
  return { modelId, success: true, ...completion(content) };
}

describe('JudgePanel', () => {
  it('anonymizes candidates, permutes labels, and resolves an independent majority', async () => {
    const gateway = new JudgeGateway();
    const task = makeTask();
    const match: ScheduledMatch = {
      id: 'match-test-2',
      runId: 'run-test',
      index: 0,
      seed: 'seed',
      category: 'reasoning',
      taskId: task.public.id,
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'minimax/minimax-m3',
    };
    const firstJudge = listModels('judge')[0]!.id;
    const panel = await new JudgePanel(
      gateway,
      undefined,
      undefined,
      (_matchId, judgeId) => judgeId === firstJudge,
    ).judge({
      match,
      task,
      responseA: response(match.modelA, 'CORRECT grounded answer. I am GPT-5.6 Sol from OpenAI.'),
      responseB: response(match.modelB, 'incorrect answer from MiniMax M3.'),
    });
    expect(panel.winnerModelId).toBe(match.modelA);
    expect(panel.validVotes).toBe(3);
    expect(panel.agreement).toBe('unanimous');
    expect(gateway.requests).toHaveLength(3);
    for (const request of gateway.requests) {
      const payload = JSON.parse(request.user) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(['task', 'hiddenReference', 'modelA', 'modelB']);
      expect(payload.modelA).toMatchObject({ label: 'Model A' });
      expect(payload.modelB).toMatchObject({ label: 'Model B' });
      const completeJudgeMessage = `${request.system}\n${request.user}`.toLowerCase();
      for (const competitor of listModels('competitor')) {
        expect(completeJudgeMessage).not.toContain(competitor.id.toLowerCase());
        expect(completeJudgeMessage).not.toContain(competitor.canonicalSlug.toLowerCase());
        expect(completeJudgeMessage).not.toContain(competitor.displayName.toLowerCase());
        expect(completeJudgeMessage).not.toContain(competitor.vendor.toLowerCase());
      }
      expect(request.user).toContain('[MODEL IDENTITY REDACTED]');
      expect(request.model.role).toBe('judge');
    }
    expect(new Set(panel.votes.map((vote) => vote.modelAIdentity)).size).toBeGreaterThan(1);
  });

  it.each([
    {
      name: 'unanimous',
      winners: ['MODEL_A', 'MODEL_A', 'MODEL_A'] as const,
      agreement: 'unanimous',
      winner: 'openai/gpt-5.6-sol',
    },
    {
      name: 'split',
      winners: ['MODEL_A', 'MODEL_A', 'MODEL_B'] as const,
      agreement: 'split',
      winner: 'openai/gpt-5.6-sol',
    },
    {
      name: 'insufficient after an abstention',
      winners: ['MODEL_A', 'MODEL_B', null] as const,
      agreement: 'insufficient',
      winner: null,
    },
  ])('resolves $name panels', async ({ winners, agreement, winner }) => {
    const judges = listModels('judge');
    const configured = new Map(judges.map((judge, index) => [judge.id, winners[index] ?? null]));
    const gateway = new FixtureGateway((request) => {
      const selected = configured.get(request.model.id);
      if (selected === null) return makeCompletion('not valid JSON');
      const vote = makeVote(
        request.model.id,
        selected === 'MODEL_A' ? 'openai/gpt-5.6-sol' : 'minimax/minimax-m3',
        'openai/gpt-5.6-sol',
        'minimax/minimax-m3',
      );
      return makeCompletion(JSON.stringify(vote.verdict));
    });
    const task = makeTask();
    const match: ScheduledMatch = {
      id: 'match-panel',
      runId: 'run-panel',
      index: 0,
      seed: 'panel',
      category: 'reasoning',
      taskId: task.public.id,
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'minimax/minimax-m3',
    };
    const panel = await new JudgePanel(gateway, undefined, undefined, () => false).judge({
      match,
      task,
      responseA: makeSuccess(match.modelA, 'answer a'),
      responseB: makeSuccess(match.modelB, 'answer b'),
    });
    expect(panel.agreement).toBe(agreement);
    expect(panel.winnerModelId).toBe(winner);
  });

  it('retries one malformed verdict before accepting it', async () => {
    const attempts = new Map<string, number>();
    const gateway = new FixtureGateway((request) => {
      const attempt = (attempts.get(request.model.id) ?? 0) + 1;
      attempts.set(request.model.id, attempt);
      if (request.model.id === listModels('judge')[0]!.id && attempt === 1) {
        return makeCompletion('not valid JSON');
      }
      return makeCompletion(
        JSON.stringify(
          makeVote(
            request.model.id,
            'openai/gpt-5.6-sol',
            'openai/gpt-5.6-sol',
            'minimax/minimax-m3',
          ).verdict,
        ),
      );
    });
    const task = makeTask();
    const match: ScheduledMatch = {
      id: 'match-retry',
      runId: 'run-retry',
      index: 0,
      seed: 'retry',
      category: 'reasoning',
      taskId: task.public.id,
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'minimax/minimax-m3',
    };
    const panel = await new JudgePanel(gateway, undefined, undefined, () => false).judge({
      match,
      task,
      responseA: makeSuccess(match.modelA),
      responseB: makeSuccess(match.modelB),
    });
    expect(panel.agreement).toBe('unanimous');
    expect(gateway.requests).toHaveLength(4);
  });
});
