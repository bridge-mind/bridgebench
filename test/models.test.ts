import { describe, expect, it } from 'vitest';

import {
  MODEL_REGISTRY,
  getJudgeModel,
  getModel,
  listModels,
  resolveCompetitorRoster,
} from '../src/models.js';

const DUAL_ROLE_IDS = ['x-ai/grok-4.5', 'z-ai/glm-5.2'] as const;

describe.each(DUAL_ROLE_IDS)('dual-role roster semantics (%s)', (dualRoleId) => {
  it('lists a dual-role model as a competitor with its competitor policy', () => {
    const competitors = listModels('competitor');
    const model = competitors.find((entry) => entry.id === dualRoleId);
    expect(model).toBeDefined();
    expect(model?.role).toBe('competitor');
    expect(model?.request.reasoningEffort).toBe('high');
  });

  it('keeps the dual-role model on the judge panel as an acting judge', () => {
    const judges = listModels('judge');
    expect(judges.map((judge) => judge.id)).toContain(dualRoleId);
    expect(judges).toHaveLength(3);
    const model = judges.find((judge) => judge.id === dualRoleId);
    expect(model?.role).toBe('judge');
    // Judge-side calls use the judge policy, not the competitor one.
    expect(model?.request).toEqual(MODEL_REGISTRY[dualRoleId]?.judgeRequest);
  });

  it('resolves judge-view entries only for panel members', () => {
    expect(getJudgeModel(dualRoleId).role).toBe('judge');
    expect(getJudgeModel('google/gemini-3.1-pro-preview').role).toBe('judge');
    expect(() => getJudgeModel('openai/gpt-5.6-sol')).toThrow(/judge/i);
  });

  it('accepts the dual-role model in a competitor roster', () => {
    const roster = resolveCompetitorRoster([
      dualRoleId,
      'anthropic/claude-fable-5',
    ]);
    expect(roster.map((model) => model.id).sort()).toEqual(
      ['anthropic/claude-fable-5', dualRoleId].sort(),
    );
  });

  it('getModel returns the registry (competitor) view of a dual-role model', () => {
    expect(getModel(dualRoleId).role).toBe('competitor');
  });
});

describe('single-role roster semantics', () => {
  it('still rejects pure judges as competitors', () => {
    expect(() =>
      resolveCompetitorRoster([
        'google/gemini-3.1-pro-preview',
        'anthropic/claude-fable-5',
      ]),
    ).toThrow(/competitor role required/);
  });

  it('pairs both dual-role models against each other', () => {
    const roster = resolveCompetitorRoster([...DUAL_ROLE_IDS]);
    expect(roster.map((model) => model.id).sort()).toEqual(
      [...DUAL_ROLE_IDS].sort(),
    );
  });
});
