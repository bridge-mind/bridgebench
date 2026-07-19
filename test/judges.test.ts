import { describe, expect, it } from 'vitest';

import { anonymizeCompetitorOutput, JudgePanel } from '../src/judges.js';
import { getJudgeModel, listModels } from '../src/models.js';
import { FixtureGateway, makeCompletion, makeSuccess, makeTask, makeVote } from './helpers.js';
import type {
  ChatRequest,
  CompetitorSuccess,
  CompleteArenaTask,
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
        decisiveDifference: {
          deliverableId: 'd1',
          winnerClaim: 'Matches the supported conclusion.',
          loserError: 'Contradicts the reference.',
          artifactIds: ['fixture-spec'],
          rubricCriterion: 'correctness',
        },
        abstainReason: null,
      }),
    );
  }
}

function response(modelId: string, content: string): CompetitorSuccess {
  return { modelId, success: true, ...completion(content) };
}

// A valid seated trio for the sol-vs-minimax fixture matches below: none of
// these three shares a vendor with either competitor.
const SEATED_JUDGES = ['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5', 'z-ai/glm-5.2'].map(
  getJudgeModel,
);

describe('anonymizeCompetitorOutput', () => {
  const REDACTED = '[MODEL IDENTITY REDACTED]';

  it('redacts bare family names including Grok and GLM', () => {
    const anonymous = anonymizeCompetitorOutput(
      'Grok would answer differently; GLM-5.2 and Gemini agree, per DeepSeek and Qwen.',
    );
    expect(anonymous).not.toMatch(/Grok|GLM|Gemini|DeepSeek|Qwen/);
    expect(anonymous).toContain(REDACTED);
  });

  it('spares ordinary prose that collides with capitalized family names', () => {
    expect(anonymizeCompetitorOutput('Once you grok the invariant, the fix is one line.')).toBe(
      'Once you grok the invariant, the fix is one line.',
    );
    expect(anonymizeCompetitorOutput('fit a glm on the residuals')).toBe(
      'fit a glm on the residuals',
    );
  });

  it('redacts ambiguous family terms only inside identity claims', () => {
    expect(anonymizeCompetitorOutput('I am Opus, built to help.')).toContain(REDACTED);
    expect(anonymizeCompetitorOutput("I'm Sol. Here is the diff.")).toContain(REDACTED);
    // The same tokens in ordinary technical prose survive.
    const prose =
      'This refactor is the opus of the sprint; the Luna scheduler and Terra config are unchanged.';
    expect(anonymizeCompetitorOutput(prose)).toBe(prose);
  });
});

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
    const firstJudge = SEATED_JUDGES[0]!.id;
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
      judges: SEATED_JUDGES,
    });
    expect(panel.winnerModelId).toBe(match.modelA);
    expect(panel.validVotes).toBe(3);
    expect(panel.agreement).toBe('unanimous');
    // Reasoning pilots two-pass judging: each vote is one reference-free
    // derivation request plus one structured reconcile request.
    expect(gateway.requests).toHaveLength(6);
    expect(gateway.requests.filter((request) => request.structured)).toHaveLength(3);
    for (const request of gateway.requests) {
      const payload = JSON.parse(request.user) as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(
        request.structured
          ? ['task', 'hiddenReference', 'independentDerivation', 'modelA', 'modelB']
          : ['task', 'modelA', 'modelB'],
      );
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

  it('shares structured deliverables with judges and validates decisive references', async () => {
    const deliverable = (id: string) => ({
      id,
      classification: 'determinable' as const,
      expectedAnswer: 'The supported conclusion is alpha.',
      evidenceArtifactIds: ['fixture-spec'],
      disqualifiers: [],
      weight: 1,
    });
    const judgeInput = (task: CompleteArenaTask) => ({
      match: {
        id: 'match-deliverables',
        runId: 'run-test',
        index: 0,
        seed: 'seed',
        category: 'reasoning' as const,
        taskId: task.public.id,
        modelA: 'openai/gpt-5.6-sol',
        modelB: 'minimax/minimax-m3',
      },
      task,
      responseA: response('openai/gpt-5.6-sol', 'CORRECT grounded answer.'),
      responseB: response('minimax/minimax-m3', 'incorrect answer.'),
      judges: SEATED_JUDGES,
    });

    // The mock judge always cites deliverable d1: with d1 in the rubric the
    // panel resolves, and the payload carries the structured deliverables.
    const matching = new JudgeGateway();
    const withD1 = makeTask({}, { deliverables: [deliverable('d1')] });
    const resolved = await new JudgePanel(matching).judge(judgeInput(withD1));
    expect(resolved.winnerModelId).toBe('openai/gpt-5.6-sol');
    const structuredRequests = matching.requests.filter((request) => request.structured);
    expect(structuredRequests.length).toBeGreaterThan(0);
    for (const request of structuredRequests) {
      const payload = JSON.parse(request.user) as {
        hiddenReference: { deliverables?: unknown[] };
      };
      expect(payload.hiddenReference.deliverables).toHaveLength(1);
    }

    // With a rubric that has no d1, every d1-citing verdict fails validation
    // and the whole panel abstains into a no-contest.
    const mismatched = new JudgeGateway();
    const withoutD1 = makeTask({}, { deliverables: [deliverable('d2')] });
    const voided = await new JudgePanel(mismatched).judge(judgeInput(withoutD1));
    expect(voided.winnerModelId).toBeNull();
    expect(voided.validVotes).toBe(0);
    expect(voided.agreement).toBe('insufficient');
  });

  it('keeps single-pass judging outside the two-pass pilot categories', async () => {
    const gateway = new JudgeGateway();
    const task = makeTask({ category: 'debugging' });
    const match: ScheduledMatch = {
      id: 'match-single-pass',
      runId: 'run-test',
      index: 0,
      seed: 'seed',
      category: 'debugging',
      taskId: task.public.id,
      modelA: 'openai/gpt-5.6-sol',
      modelB: 'minimax/minimax-m3',
    };
    const panel = await new JudgePanel(gateway).judge({
      match,
      task,
      responseA: response(match.modelA, 'CORRECT grounded answer.'),
      responseB: response(match.modelB, 'incorrect answer.'),
      judges: SEATED_JUDGES,
    });
    expect(panel.winnerModelId).toBe(match.modelA);
    expect(gateway.requests).toHaveLength(3);
    for (const request of gateway.requests) {
      expect(request.structured).toBe(true);
      expect(JSON.parse(request.user)).not.toHaveProperty('independentDerivation');
    }
  });

  it('counterbalances seats deterministically across the panel by default', async () => {
    const task = makeTask();
    const runPanel = async (matchId: string) => {
      const match: ScheduledMatch = {
        id: matchId,
        runId: 'run-counterbalance',
        index: 0,
        seed: 'seed',
        category: 'reasoning',
        taskId: task.public.id,
        modelA: 'openai/gpt-5.6-sol',
        modelB: 'minimax/minimax-m3',
      };
      // No swap override: the production counterbalanced default applies.
      return new JudgePanel(new JudgeGateway()).judge({
        match,
        task,
        responseA: response(match.modelA, 'CORRECT grounded answer.'),
        responseB: response(match.modelB, 'incorrect answer.'),
        judges: SEATED_JUDGES,
      });
    };
    for (const matchId of ['match-cb-1', 'match-cb-2', 'match-cb-3']) {
      const panel = await runPanel(matchId);
      // Every 3-judge panel seats each competitor in seat A at least once and
      // at most twice — a 3-0 seating can no longer occur.
      const seatACounts = new Map<string, number>();
      for (const vote of panel.votes) {
        seatACounts.set(vote.modelAIdentity, (seatACounts.get(vote.modelAIdentity) ?? 0) + 1);
      }
      expect([...seatACounts.values()].sort()).toEqual([1, 2]);
      // And the assignment is deterministic: replaying the match reproduces it.
      const replay = await runPanel(matchId);
      expect(replay.votes.map((vote) => vote.modelAIdentity)).toEqual(
        panel.votes.map((vote) => vote.modelAIdentity),
      );
    }
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
    const judges = SEATED_JUDGES;
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
      judges: SEATED_JUDGES,
    });
    expect(panel.agreement).toBe(agreement);
    expect(panel.winnerModelId).toBe(winner);
  });

  describe('adaptive adjudication', () => {
    // fable-vs-minimax leaves five eligible pool judges: gemini/grok/glm as
    // the primary trio here, sol/kimi as the two adjudication reserves.
    const PRIMARY = SEATED_JUDGES;
    const RESERVES = ['openai/gpt-5.6-sol', 'moonshotai/kimi-k2.7-code'].map(getJudgeModel);
    const MODEL_A_ID = 'anthropic/claude-fable-5';
    const MODEL_B_ID = 'minimax/minimax-m3';

    const verdictJson = (winner: 'MODEL_A' | 'MODEL_B' | 'TIE' | 'ABSTAIN'): string =>
      JSON.stringify({
        winner,
        confidence: 0.8,
        rationale: 'Adjudication fixture rationale.',
        criteria: {
          correctness: 'x',
          grounding: 'x',
          constraintHandling: 'x',
          completeness: 'x',
        },
        violations: [],
        decisiveDifference:
          winner === 'MODEL_A' || winner === 'MODEL_B'
            ? {
                deliverableId: 'd1',
                winnerClaim: 'Right conclusion.',
                loserError: 'Wrong conclusion.',
                artifactIds: ['fixture-spec'],
                rubricCriterion: 'correctness',
              }
            : null,
        abstainReason: winner === 'ABSTAIN' ? 'insufficient-evidence' : null,
      });

    const panelFor = async (
      votesByJudge: Record<string, 'MODEL_A' | 'MODEL_B' | 'TIE' | 'ABSTAIN'>,
      reserveJudges = RESERVES,
    ) => {
      const gateway = new FixtureGateway((request) =>
        makeCompletion(verdictJson(votesByJudge[request.model.id] ?? 'MODEL_A')),
      );
      const task = makeTask();
      const match: ScheduledMatch = {
        id: 'match-adjudication',
        runId: 'run-adjudication',
        index: 0,
        seed: 'adjudication',
        category: 'reasoning',
        taskId: task.public.id,
        modelA: MODEL_A_ID,
        modelB: MODEL_B_ID,
      };
      return {
        gateway,
        panel: await new JudgePanel(gateway, undefined, undefined, () => false).judge({
          match,
          task,
          responseA: makeSuccess(MODEL_A_ID, 'answer a'),
          responseB: makeSuccess(MODEL_B_ID, 'answer b'),
          judges: PRIMARY,
          reserveJudges,
        }),
      };
    };

    it('escalates a split primary panel and resolves best-of-5', async () => {
      const { gateway, panel } = await panelFor({
        [PRIMARY[0]!.id]: 'MODEL_A',
        [PRIMARY[1]!.id]: 'MODEL_A',
        [PRIMARY[2]!.id]: 'MODEL_B',
        [RESERVES[0]!.id]: 'MODEL_A',
        [RESERVES[1]!.id]: 'MODEL_B',
      });
      expect(gateway.requests.filter((request) => request.structured)).toHaveLength(5);
      expect(panel.votes).toHaveLength(5);
      expect(panel.adjudicated).toBe(true);
      expect(panel.winnerModelId).toBe(MODEL_A_ID);
      expect(panel.votesByModel).toEqual({ [MODEL_A_ID]: 3, [MODEL_B_ID]: 2 });
      expect(panel.agreement).toBe('split');
    });

    it('rejects TIE completions as forced-choice violations and escalates on lost votes', async () => {
      // Judges that insist on TIE burn both structured attempts and journal
      // as abstentions (verdict null) — they never become valid tie votes.
      const { panel } = await panelFor({
        [PRIMARY[0]!.id]: 'TIE',
        [PRIMARY[1]!.id]: 'TIE',
        [PRIMARY[2]!.id]: 'MODEL_A',
        [RESERVES[0]!.id]: 'TIE',
        [RESERVES[1]!.id]: 'MODEL_B',
      });
      expect(panel.adjudicated).toBe(true);
      expect(panel.tieVotes).toBe(0);
      const rejected = panel.votes.filter((vote) => vote.verdict === null);
      expect(rejected).toHaveLength(3);
      for (const vote of rejected) {
        expect(vote.error).toMatch(/forced-choice/);
      }
      expect(panel.winnerModelId).toBeNull();
      expect(panel.agreement).toBe('insufficient');
    });

    it('does not escalate a fully-abstained panel (futile: no reachable majority)', async () => {
      const { gateway, panel } = await panelFor({
        [PRIMARY[0]!.id]: 'TIE',
        [PRIMARY[1]!.id]: 'TIE',
        [PRIMARY[2]!.id]: 'TIE',
      });
      // All three primaries burned both structured attempts on rejected TIE
      // completions (2 × 3 requests) and journal as abstentions. Reserves
      // could add at most 2 decisive votes against an enlarged majority of 3,
      // so seating them cannot change the no-contest outcome.
      expect(gateway.requests.filter((request) => request.structured)).toHaveLength(6);
      expect(panel.adjudicated).toBe(false);
      expect(panel.validVotes).toBe(0);
      expect(panel.winnerModelId).toBeNull();
      expect(panel.agreement).toBe('insufficient');
    });

    it('does not escalate a clean unanimous panel', async () => {
      const { gateway, panel } = await panelFor({
        [PRIMARY[0]!.id]: 'MODEL_A',
        [PRIMARY[1]!.id]: 'MODEL_A',
        [PRIMARY[2]!.id]: 'MODEL_A',
      });
      expect(gateway.requests.filter((request) => request.structured)).toHaveLength(3);
      expect(panel.adjudicated).toBe(false);
      expect(panel.agreement).toBe('unanimous');
      expect(panel.winnerModelId).toBe(MODEL_A_ID);
    });

    it('lets a 2-1 split stand when the pool has no reserves', async () => {
      const { gateway, panel } = await panelFor(
        {
          [PRIMARY[0]!.id]: 'MODEL_A',
          [PRIMARY[1]!.id]: 'MODEL_A',
          [PRIMARY[2]!.id]: 'MODEL_B',
        },
        [],
      );
      expect(gateway.requests.filter((request) => request.structured)).toHaveLength(3);
      expect(panel.adjudicated).toBe(false);
      expect(panel.winnerModelId).toBe(MODEL_A_ID);
      expect(panel.agreement).toBe('split');
    });

    it('rejects an ABSTAIN completion and settles via the reserves', async () => {
      const { panel } = await panelFor({
        [PRIMARY[0]!.id]: 'MODEL_A',
        [PRIMARY[1]!.id]: 'MODEL_A',
        [PRIMARY[2]!.id]: 'ABSTAIN',
        [RESERVES[0]!.id]: 'MODEL_A',
        [RESERVES[1]!.id]: 'MODEL_A',
      });
      expect(panel.adjudicated).toBe(true);
      const abstained = panel.votes.find((vote) => vote.verdict === null);
      expect(abstained?.winnerModelId).toBeNull();
      expect(abstained?.error).toMatch(/forced-choice/);
      expect(panel.winnerModelId).toBe(MODEL_A_ID);
      expect(panel.votesByModel[MODEL_A_ID]).toBe(4);
    });
  });

  it('retries one malformed verdict before accepting it', async () => {
    const attempts = new Map<string, number>();
    const gateway = new FixtureGateway((request) => {
      // Derivation passes are free-form; only structured verdict attempts
      // exercise the retry path.
      if (!request.structured) return makeCompletion('pass-one derivation');
      const attempt = (attempts.get(request.model.id) ?? 0) + 1;
      attempts.set(request.model.id, attempt);
      if (request.model.id === SEATED_JUDGES[0]!.id && attempt === 1) {
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
      judges: SEATED_JUDGES,
    });
    expect(panel.agreement).toBe('unanimous');
    expect(gateway.requests.filter((request) => request.structured)).toHaveLength(4);
  });
});
