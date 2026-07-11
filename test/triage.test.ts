import { describe, expect, it } from 'vitest';

import { classifyError, detectResponseAnomalies, triageJournal } from '../src/triage.js';
import type { CompetitorResponse, MatchResult } from '../src/types.js';

function response(overrides: Partial<CompetitorResponse>): CompetitorResponse {
  return {
    modelId: 'openai/gpt-5.6-sol',
    success: true,
    generationId: 'gen-1',
    content: 'x'.repeat(2_000),
    inputTokens: 500,
    outputTokens: 900,
    reasoningTokens: 400,
    costUsd: 0.02,
    latencyMs: 45_000,
    finishReason: 'stop',
    ...overrides,
  };
}

function match(overrides: Partial<MatchResult> & { responseA: CompetitorResponse; responseB: CompetitorResponse }): MatchResult {
  const { responseA, responseB, ...rest } = overrides;
  return {
    methodologyVersion: 'reasoning-arena-v0.2.0',
    runId: 'run-test',
    matchId: 'match-test',
    scheduleIndex: 0,
    seed: 'triage-seed',
    timestamp: '2026-07-10T16:00:00.000Z',
    task: { id: 'stateful-retry-budget', version: '1.0.0', cluster: 'stateful-execution', publicHash: 'a', privateHash: 'b' },
    competitors: { modelA: responseA.modelId, modelB: responseB.modelId, responseA, responseB },
    outcome: 'judged',
    winnerModelId: responseA.modelId,
    panel: null,
    eloBefore: {},
    eloAfter: {},
    pointAwarded: true,
    matchCostUsd: responseA.costUsd + responseB.costUsd,
    ...rest,
  };
}

describe('response anomaly detection', () => {
  it('passes a healthy slow reasoning response', () => {
    expect(detectResponseAnomalies(response({}))).toEqual([]);
  });

  it('flags failures ahead of everything else', () => {
    expect(detectResponseAnomalies(response({ success: false, error: 'Premature close', latencyMs: 0 }))).toEqual(['failed']);
  });

  it('flags the suspicious fast-and-shallow profile from the July 10 run', () => {
    const flags = detectResponseAnomalies(
      response({ latencyMs: 3_258, outputTokens: 447, reasoningTokens: undefined, costUsd: 0.01 }),
    );
    expect(flags).toContain('fast-response');
    expect(flags).toContain('reasoning-unreported');
  });

  it('flags truncation and zero cost', () => {
    const flags = detectResponseAnomalies(response({ finishReason: 'length', costUsd: 0 }));
    expect(flags).toEqual(['truncated', 'zero-cost']);
  });
});

describe('error classification', () => {
  it('classifies the transport failure that killed the first run', () => {
    expect(
      classifyError('Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close'),
    ).toBe('premature-close');
    expect(classifyError('OpenRouter request timed out after 300000ms')).toBe('timeout');
    expect(classifyError('429 rate limit exceeded')).toBe('rate-limit');
  });
});

describe('journal triage', () => {
  it('reports a run where every match was a silent no-contest', () => {
    const dead = (index: number): MatchResult =>
      match({
        matchId: `match-${index}`,
        scheduleIndex: index,
        outcome: 'no-contest',
        winnerModelId: null,
        pointAwarded: false,
        matchCostUsd: 0,
        responseA: response({ success: false, error: 'fetch failed: Premature close', latencyMs: 0, outputTokens: 0, costUsd: 0 }),
        responseB: response({
          modelId: 'anthropic/claude-fable-5',
          success: false,
          error: 'fetch failed: Premature close',
          latencyMs: 0,
          outputTokens: 0,
          costUsd: 0,
        }),
      });
    const [report] = triageJournal([dead(0), dead(1), dead(2)]);
    expect(report!.outcomes['no-contest']).toBe(3);
    expect(report!.errorClasses['premature-close']).toBe(6);
    expect(report!.anomalies.filter((anomaly) => anomaly.flag === 'failed')).toHaveLength(6);
    expect(report!.models['openai/gpt-5.6-sol']!.failures).toBe(3);
  });

  it('counts judge abstentions and zero-cost judged matches as anomalies', () => {
    const judged = match({
      responseA: response({}),
      responseB: response({ modelId: 'anthropic/claude-fable-5' }),
      matchCostUsd: 0,
      panel: {
        winnerModelId: 'openai/gpt-5.6-sol',
        validVotes: 2,
        votesByModel: { 'openai/gpt-5.6-sol': 2, 'anthropic/claude-fable-5': 0 },
        agreement: 'split',
        votes: [
          {
            judgeModelId: 'x-ai/grok-4.5',
            modelAIdentity: 'openai/gpt-5.6-sol',
            modelBIdentity: 'anthropic/claude-fable-5',
            verdict: null,
            winnerModelId: null,
            completion: null,
            error: 'schema mismatch',
          },
        ],
      },
    });
    const [report] = triageJournal([judged]);
    expect(report!.judge.abstentions).toBe(1);
    expect(report!.anomalies.map((anomaly) => anomaly.flag)).toEqual(
      expect.arrayContaining(['judge-abstained', 'zero-cost-match']),
    );
  });
});
