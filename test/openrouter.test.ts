import { describe, expect, it } from 'vitest';

import {
  isRetryableError,
  isRetryableFailure,
  parseJudgeVerdict,
  sanitizeError,
} from '../src/openrouter.js';
import { judgeVerdictJsonSchema } from '../src/openrouter-transport.js';

describe('OpenRouter boundary helpers', () => {
  const baseVerdict = {
    winner: 'MODEL_A',
    confidence: 0.8,
    rationale: 'Model A is grounded.',
    criteria: {
      correctness: 'A',
      grounding: 'A',
      constraintHandling: 'A',
      completeness: 'A',
    },
    violations: [],
    decisiveDifference: {
      deliverableId: 'd1',
      winnerClaim: 'Correctly resolved the deliverable.',
      loserError: 'Contradicted the artifact.',
      artifactIds: ['spec-1'],
      rubricCriterion: 'correctness',
    },
    abstainReason: null,
  };

  it('validates structured judge output', () => {
    const verdict = parseJudgeVerdict(JSON.stringify(baseVerdict));
    expect(verdict.winner).toBe('MODEL_A');
    expect(verdict.decisiveDifference?.deliverableId).toBe('d1');
  });

  it('rejects a decisive verdict without a decisive difference', () => {
    expect(() =>
      parseJudgeVerdict(JSON.stringify({ ...baseVerdict, decisiveDifference: null })),
    ).toThrow(/requires a non-null decisiveDifference/);
  });

  it('rejects a decisive difference citing an unknown artifact id', () => {
    expect(() =>
      parseJudgeVerdict(JSON.stringify(baseVerdict), { artifactIds: ['other-artifact'] }),
    ).toThrow(/unknown artifact id/);
    expect(parseJudgeVerdict(JSON.stringify(baseVerdict), { artifactIds: ['spec-1'] }).winner).toBe(
      'MODEL_A',
    );
  });

  it('rejects a decisive difference citing an unknown deliverable id', () => {
    expect(() =>
      parseJudgeVerdict(JSON.stringify(baseVerdict), {
        deliverableIds: ['d2', 'd3'],
      }),
    ).toThrow(/unknown deliverable id d1/);
    expect(
      parseJudgeVerdict(JSON.stringify(baseVerdict), {
        deliverableIds: ['d1', 'd2'],
      }).winner,
    ).toBe('MODEL_A');
    // Prose-rubric tasks pass no deliverable IDs — any label is allowed.
    expect(parseJudgeVerdict(JSON.stringify(baseVerdict), {}).winner).toBe('MODEL_A');
  });

  it('rejects TIE and ABSTAIN — live judging is forced-choice', () => {
    const tie = { ...baseVerdict, winner: 'TIE', decisiveDifference: null };
    expect(() => parseJudgeVerdict(JSON.stringify(tie))).toThrow(/forced-choice/);
    const abstain = {
      ...baseVerdict,
      winner: 'ABSTAIN',
      decisiveDifference: null,
      abstainReason: 'insufficient-evidence',
    };
    expect(() => parseJudgeVerdict(JSON.stringify(abstain))).toThrow(/forced-choice/);
  });

  it('generates a provider-compatible transport subset from the runtime contract', () => {
    const schema = JSON.stringify(judgeVerdictJsonSchema());
    expect(schema).toContain('"additionalProperties":false');
    expect(schema).toContain('"MODEL_A"');
    // Forced-choice: the transport enum offers no TIE or ABSTAIN escape hatch.
    expect(schema).not.toContain('"TIE"');
    expect(schema).not.toContain('"ABSTAIN"');
    expect(schema).not.toContain('"$schema"');
    expect(schema).not.toContain('"maxLength"');
    expect(schema).not.toContain('"maxItems"');
  });

  it('redacts credentials from surfaced errors', () => {
    expect(sanitizeError(new Error('Bearer sk-or-v1-secretvalue failed'))).not.toContain(
      'secretvalue',
    );
  });

  it('classifies dropped-connection errors as retryable', () => {
    expect(
      isRetryableError(
        'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close',
      ),
    ).toBe(true);
    expect(isRetryableError('socket hang up')).toBe(true);
    expect(isRetryableError('fetch failed')).toBe(true);
    expect(isRetryableError('OpenRouter stream timed out after 300000ms')).toBe(true);
    expect(isRetryableError('429 rate limit exceeded')).toBe(true);
    // Transient provider glitch (reasoning burn, upstream drop) — must retry,
    // not convert directly into a judge abstention or competitor forfeit.
    expect(isRetryableError('OpenRouter returned an empty completion')).toBe(true);
  });

  it('does not retry non-transient errors', () => {
    expect(isRetryableError('401 Unauthorized')).toBe(false);
    expect(isRetryableError('Prompt exceeds 180000 character safety limit')).toBe(false);
  });

  it('classifies provider outages structurally, not just by message text', () => {
    // The 2026-07-14 OpenAI outage: SDK APIError with bare status text and no
    // digits in the message — must retry via the status code.
    const outage = Object.assign(new Error('Internal Server Error'), { status: 500 });
    expect(isRetryableFailure(outage, outage.message)).toBe(true);
    // Bare status-text messages with no structural status retry via the regex.
    expect(isRetryableFailure(new Error('Internal Server Error'), 'Internal Server Error')).toBe(
      true,
    );
    expect(isRetryableFailure(new Error('Bad Gateway'), 'Bad Gateway')).toBe(true);
    expect(isRetryableFailure(new Error('Service Unavailable'), 'Service Unavailable')).toBe(true);
    // Network errors carry a code, not a status.
    const reset = Object.assign(new Error('read failed'), { code: 'ECONNRESET' });
    expect(isRetryableFailure(reset, reset.message)).toBe(true);
    // Real client errors stay permanent even with a structural status.
    const unauthorized = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isRetryableFailure(unauthorized, unauthorized.message)).toBe(false);
    expect(isRetryableFailure(new Error('No endpoints found'), 'No endpoints found')).toBe(false);
  });
});
