import { describe, expect, it } from 'vitest';

import {
  MODEL_REGISTRY,
  getJudgeModel,
  getModel,
  listModels,
  resolveCompetitorRoster,
} from '../src/models.js';

const DUAL_ROLE_ID = 'x-ai/grok-4.5';

describe('dual-role roster semantics', () => {
  it('lists a dual-role model as a competitor with its competitor policy', () => {
    const competitors = listModels('competitor');
    const grok = competitors.find((model) => model.id === DUAL_ROLE_ID);
    expect(grok).toBeDefined();
    expect(grok?.role).toBe('competitor');
    expect(grok?.request.reasoningEffort).toBe('high');
  });

  it('keeps the dual-role model on the judge panel as an acting judge', () => {
    const judges = listModels('judge');
    expect(judges.map((judge) => judge.id)).toContain(DUAL_ROLE_ID);
    expect(judges).toHaveLength(3);
    const grok = judges.find((judge) => judge.id === DUAL_ROLE_ID);
    expect(grok?.role).toBe('judge');
    // Judge-side calls use the judge policy, not the competitor one.
    expect(grok?.request).toEqual(MODEL_REGISTRY[DUAL_ROLE_ID].judgeRequest);
  });

  it('resolves judge-view entries only for panel members', () => {
    expect(getJudgeModel(DUAL_ROLE_ID).role).toBe('judge');
    expect(getJudgeModel('google/gemini-3.1-pro-preview').role).toBe('judge');
    expect(() => getJudgeModel('openai/gpt-5.6-sol')).toThrow(/judge/i);
  });

  it('accepts the dual-role model in a competitor roster', () => {
    const roster = resolveCompetitorRoster([
      DUAL_ROLE_ID,
      'anthropic/claude-fable-5',
    ]);
    expect(roster.map((model) => model.id).sort()).toEqual(
      ['anthropic/claude-fable-5', DUAL_ROLE_ID].sort(),
    );
  });

  it('still rejects pure judges as competitors', () => {
    expect(() =>
      resolveCompetitorRoster([
        'google/gemini-3.1-pro-preview',
        'anthropic/claude-fable-5',
      ]),
    ).toThrow(/competitor role required/);
  });

  it('getModel returns the registry (competitor) view of a dual-role model', () => {
    expect(getModel(DUAL_ROLE_ID).role).toBe('competitor');
  });
});
