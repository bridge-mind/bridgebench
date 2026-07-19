import { describe, expect, it } from 'vitest';

import {
  MODEL_REGISTRY,
  getJudgeModel,
  getModel,
  listModels,
  resolveCompetitorRoster,
} from '../src/models.js';
import { vendorOf } from '../src/seating.js';

// Since the 2026-07-18 coding-index wave every judge pool member is
// dual-role: Gemini, Mistral, and Nemotron compete too.
const DUAL_ROLE_IDS = [
  'x-ai/grok-4.5',
  'z-ai/glm-5.2',
  'openai/gpt-5.6-sol',
  'moonshotai/kimi-k2.7-code',
  'google/gemini-3.1-pro-preview',
  'mistralai/mistral-medium-3-5',
  'nvidia/nemotron-3-ultra-550b-a55b',
] as const;

const JUDGE_POOL_IDS = [...DUAL_ROLE_IDS] as const;

describe.each(DUAL_ROLE_IDS)('dual-role roster semantics (%s)', (dualRoleId) => {
  it('lists a dual-role model as a competitor with its competitor policy', () => {
    const competitors = listModels('competitor');
    const model = competitors.find((entry) => entry.id === dualRoleId);
    expect(model).toBeDefined();
    expect(model?.role).toBe('competitor');
    expect(model?.request.reasoningEffort).toBe('high');
  });

  it('keeps the dual-role model in the judge pool as an acting judge', () => {
    const judges = listModels('judge');
    expect(judges.map((judge) => judge.id)).toContain(dualRoleId);
    const model = judges.find((judge) => judge.id === dualRoleId);
    expect(model?.role).toBe('judge');
    // Judge-side calls use the judge policy, not the competitor one.
    expect(model?.request).toEqual(MODEL_REGISTRY[dualRoleId]?.judgeRequest);
  });

  it('resolves judge-view entries only for pool members', () => {
    expect(getJudgeModel(dualRoleId).role).toBe('judge');
    expect(getJudgeModel('google/gemini-3.1-pro-preview').role).toBe('judge');
    expect(() => getJudgeModel('anthropic/claude-fable-5')).toThrow(/judge/i);
  });

  it('accepts the dual-role model in a competitor roster', () => {
    const roster = resolveCompetitorRoster([dualRoleId, 'anthropic/claude-fable-5']);
    expect(roster.map((model) => model.id).sort()).toEqual(
      ['anthropic/claude-fable-5', dualRoleId].sort(),
    );
  });

  it('getModel returns the registry (competitor) view of a dual-role model', () => {
    expect(getModel(dualRoleId).role).toBe('competitor');
  });
});

describe('judge pool composition', () => {
  it('the pool holds exactly the seven judge-capable models', () => {
    expect(
      listModels('judge')
        .map((judge) => judge.id)
        .sort(),
    ).toEqual([...JUDGE_POOL_IDS].sort());
  });

  // seatPanel resolves conflicts by the OpenRouter id prefix; a registry
  // entry whose `vendor` diverges from its prefix would be silently
  // mis-excluded, so the invariant fails loudly here instead.
  it('every registry vendor equals its OpenRouter id prefix', () => {
    for (const model of Object.values(MODEL_REGISTRY)) {
      expect(model.vendor, `vendor of ${model.id}`).toBe(vendorOf(model.id));
    }
  });
});

describe('single-role roster semantics', () => {
  // No pure judge remains in the registry since the 0023 promotions, so the
  // guard rails left to pin are the unknown-model rejection and the judge
  // resolution boundary for competitor-only entries.
  it('still rejects unknown models as competitors', () => {
    expect(() =>
      resolveCompetitorRoster(['google/gemini-2.5-pro', 'anthropic/claude-fable-5']),
    ).toThrow(/unknown/i);
  });

  it('pairs both original dual-role models against each other', () => {
    const pair = ['x-ai/grok-4.5', 'z-ai/glm-5.2'];
    const roster = resolveCompetitorRoster(pair);
    expect(roster.map((model) => model.id).sort()).toEqual([...pair].sort());
  });
});
