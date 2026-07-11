import { describe, expect, it } from 'vitest';

import { isRetryableError, parseJudgeVerdict, sanitizeError } from '../src/openrouter.js';

describe('OpenRouter boundary helpers', () => {
  it('validates structured judge output', () => {
    const verdict = parseJudgeVerdict(JSON.stringify({
      winner: 'MODEL_A', confidence: 0.8, rationale: 'Model A is grounded.',
      criteria: {
        correctness: 'A', grounding: 'A', constraintHandling: 'A', completeness: 'A',
      },
      violations: [],
    }));
    expect(verdict.winner).toBe('MODEL_A');
  });

  it('redacts credentials from surfaced errors', () => {
    expect(sanitizeError(new Error('Bearer sk-or-v1-secretvalue failed'))).not.toContain('secretvalue');
  });

  it('classifies dropped-connection errors as retryable', () => {
    expect(isRetryableError(
      'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close',
    )).toBe(true);
    expect(isRetryableError('socket hang up')).toBe(true);
    expect(isRetryableError('fetch failed')).toBe(true);
    expect(isRetryableError('OpenRouter stream timed out after 300000ms')).toBe(true);
    expect(isRetryableError('429 rate limit exceeded')).toBe(true);
  });

  it('does not retry non-transient errors', () => {
    expect(isRetryableError('401 Unauthorized')).toBe(false);
    expect(isRetryableError('Prompt exceeds 180000 character safety limit')).toBe(false);
    expect(isRetryableError('OpenRouter returned an empty completion')).toBe(false);
  });
});
