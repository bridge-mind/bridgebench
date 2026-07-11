import { describe, expect, it } from 'vitest';

import { JudgePanel } from '../src/judges.js';
import { listModels } from '../src/models.js';
import { TaskLoader } from '../src/tasks.js';
import { completeForTest } from './helpers.js';
import type { ChatRequest, CompetitorResponse, ModelCompletion, ModelRegistryEntry, OpenRouterGateway, ScheduledMatch } from '../src/types.js';

function completion(content: string): ModelCompletion {
  return {
    generationId: 'gen-test', content, inputTokens: 10, outputTokens: 5,
    costUsd: 0.001, latencyMs: 5, finishReason: 'stop',
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
    return completion(JSON.stringify({
      winner,
      confidence: 0.9,
      rationale: 'The selected response matches the reference.',
      criteria: {
        correctness: 'Correct conclusion.', grounding: 'Uses evidence.',
        constraintHandling: 'Applies constraints.', completeness: 'Answers every part.',
      },
      violations: [],
    }));
  }
}

function response(modelId: string, content: string): CompetitorResponse {
  return { modelId, success: true, ...completion(content) };
}

describe('JudgePanel', () => {
  it('anonymizes candidates, permutes labels, and resolves an independent majority', async () => {
    const gateway = new JudgeGateway();
    const task = completeForTest((await new TaskLoader('reasoning').loadAll())[0]!);
    const match: ScheduledMatch = {
      // The per-judge A/B permutation hashes matchId x judgeId, so whether any
      // two judges disagree on ordering is fixed per id and roster. This id
      // yields both orderings under the current judge roster, which the mixed-
      // identity assertion below depends on; re-pick it if the roster changes.
      id: 'match-test-2', runId: 'run-test', index: 0, seed: 'seed', category: 'reasoning', taskId: task.public.id,
      modelA: 'openai/gpt-5.6-sol', modelB: 'minimax/minimax-m3',
    };
    const panel = await new JudgePanel(gateway).judge({
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
});
