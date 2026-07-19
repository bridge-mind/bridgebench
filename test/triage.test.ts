import { describe, expect, it } from 'vitest';

import {
  analyzeJudgeCalibration,
  analyzeJudgeSeatBias,
  analyzeNoContestBias,
  BRIER_MIN_VOTES,
  classifyError,
  detectResponseAnomalies,
  formatJudgeCalibration,
  formatNoContestBias,
  formatSeatBias,
  NO_CONTEST_MIN_MATCHES,
  SEAT_SWING_MIN_SEAT_VOTES,
  SEAT_SWING_MIN_VOTES,
  triageJournal,
} from '../src/triage.js';
import type { JudgeVote } from '../src/types.js';
import {
  competitorCost,
  type CompetitorFailure,
  type CompetitorResponse,
  type CompetitorSuccess,
  type MatchResult,
} from '../src/types.js';

function response(overrides: Partial<CompetitorSuccess>): CompetitorSuccess {
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

function failure(overrides: Partial<CompetitorFailure> = {}): CompetitorFailure {
  return {
    modelId: 'openai/gpt-5.6-sol',
    success: false,
    error: 'Premature close',
    latencyMs: 0,
    ...overrides,
  };
}

function match(
  overrides: Partial<MatchResult> & {
    responseA: CompetitorResponse;
    responseB: CompetitorResponse;
  },
): MatchResult {
  const { responseA, responseB, ...rest } = overrides;
  return {
    methodologyVersion: 'reasoning-arena-v0.2.0',
    runId: 'run-test',
    matchId: 'match-test',
    scheduleIndex: 0,
    seed: 'triage-seed',
    timestamp: '2026-07-10T16:00:00.000Z',
    task: {
      id: 'stateful-retry-budget',
      version: '1.0.0',
      cluster: 'stateful-execution',
      publicHash: 'a',
      privateHash: 'b',
    },
    competitors: { modelA: responseA.modelId, modelB: responseB.modelId, responseA, responseB },
    outcome: 'judged',
    winnerModelId: responseA.modelId,
    panel: null,
    eloBefore: {},
    eloAfter: {},
    pointAwarded: true,
    matchCostUsd: competitorCost(responseA) + competitorCost(responseB),
    ...rest,
  };
}

describe('response anomaly detection', () => {
  it('passes a healthy slow reasoning response', () => {
    expect(detectResponseAnomalies(response({}))).toEqual([]);
  });

  it('flags failures ahead of everything else', () => {
    expect(detectResponseAnomalies(failure())).toEqual(['failed']);
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
      classifyError(
        'Invalid response body while trying to fetch https://openrouter.ai/api/v1/chat/completions: Premature close',
      ),
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
        responseA: failure({ error: 'fetch failed: Premature close' }),
        responseB: failure({
          modelId: 'anthropic/claude-fable-5',
          error: 'fetch failed: Premature close',
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

describe('judge seat-bias analysis', () => {
  const SOL = 'openai/gpt-5.6-sol';
  const FABLE = 'anthropic/claude-fable-5';

  const vote = (
    judgeModelId: string,
    seatA: string,
    seatB: string,
    winner: string | null,
  ): JudgeVote => ({
    judgeModelId,
    modelAIdentity: seatA,
    modelBIdentity: seatB,
    verdict:
      winner === null
        ? null
        : {
            winner: winner === seatA ? 'MODEL_A' : 'MODEL_B',
            confidence: 0.8,
            rationale: 'seat-bias fixture',
            criteria: {
              correctness: 'x',
              grounding: 'x',
              constraintHandling: 'x',
              completeness: 'x',
            },
            violations: [],
          },
    winnerModelId: winner,
    completion: null,
  });

  const judgedMatch = (index: number, votes: JudgeVote[]): MatchResult =>
    match({
      matchId: `match-bias-${index}`,
      scheduleIndex: index,
      responseA: response({}),
      responseB: response({ modelId: FABLE }),
      panel: {
        winnerModelId: SOL,
        validVotes: votes.filter((v) => v.winnerModelId !== null).length,
        votesByModel: { [SOL]: 0, [FABLE]: 0 },
        agreement: 'split',
        votes,
      },
    });

  it('flags a judge that rewards seat A past the alert threshold', () => {
    // Biased judge: always picks whoever sits in seat A. Seats alternate so
    // each competitor lands in both seats past SEAT_SWING_MIN_SEAT_VOTES.
    const matches: MatchResult[] = [];
    for (let index = 0; index < SEAT_SWING_MIN_VOTES; index += 1) {
      const [seatA, seatB] = index % 2 === 0 ? [SOL, FABLE] : [FABLE, SOL];
      matches.push(judgedMatch(index, [vote('biased/judge', seatA, seatB, seatA)]));
    }
    const [report] = analyzeJudgeSeatBias(matches);
    expect(report!.judgeModelId).toBe('biased/judge');
    expect(report!.votes).toBe(SEAT_SWING_MIN_VOTES);
    expect(report!.seatAPickRate).toBe(1);
    expect(report!.maxAbsSwing).toBe(1);
    expect(report!.alert).toBe(true);
    expect(formatSeatBias([report!])).toContain('ALERT');
  });

  it('stays quiet for a seat-neutral judge and below the vote window', () => {
    // Neutral judge: always picks the same competitor regardless of seat.
    const matches: MatchResult[] = [];
    for (let index = 0; index < SEAT_SWING_MIN_VOTES; index += 1) {
      const [seatA, seatB] = index % 2 === 0 ? [SOL, FABLE] : [FABLE, SOL];
      matches.push(judgedMatch(index, [vote('neutral/judge', seatA, seatB, FABLE)]));
    }
    const [report] = analyzeJudgeSeatBias(matches);
    expect(report!.seatAPickRate).toBe(0.5);
    expect(report!.maxAbsSwing).toBe(0);
    expect(report!.alert).toBe(false);

    // Same bias but too few votes: informational, never alerting.
    const few = matches.slice(0, SEAT_SWING_MIN_SEAT_VOTES);
    const fewReports = analyzeJudgeSeatBias(
      few.map((result, index) =>
        judgedMatch(index, [
          vote(
            'early/judge',
            result.panel!.votes[0]!.modelAIdentity,
            result.panel!.votes[0]!.modelBIdentity,
            result.panel!.votes[0]!.modelAIdentity,
          ),
        ]),
      ),
    );
    expect(fewReports[0]!.alert).toBe(false);
  });

  it('ignores abstentions entirely', () => {
    const matches = [judgedMatch(0, [vote('absent/judge', SOL, FABLE, null)])];
    expect(analyzeJudgeSeatBias(matches)).toEqual([]);
  });

  describe('judge confidence calibration (Brier)', () => {
    const confidentVote = (judgeModelId: string, winner: string, confidence: number): JudgeVote => {
      const base = vote(judgeModelId, SOL, FABLE, winner);
      return { ...base, verdict: { ...base.verdict!, confidence } };
    };

    it('alerts on an overconfident judge that keeps losing to the panel', () => {
      // Match winner is always SOL; this judge votes FABLE at 0.9 every time.
      const matches: MatchResult[] = [];
      for (let index = 0; index < BRIER_MIN_VOTES; index += 1) {
        matches.push(judgedMatch(index, [confidentVote('overconfident/judge', FABLE, 0.9)]));
      }
      const [report] = analyzeJudgeCalibration(matches);
      expect(report!.judgeModelId).toBe('overconfident/judge');
      expect(report!.scoredVotes).toBe(BRIER_MIN_VOTES);
      expect(report!.agreementRate).toBe(0);
      expect(report!.brierScore).toBeCloseTo(0.81, 5);
      expect(report!.alert).toBe(true);
      expect(formatJudgeCalibration([report!])).toContain('ALERT');
    });

    it('stays quiet for a well-calibrated judge and below the vote window', () => {
      const matches: MatchResult[] = [];
      for (let index = 0; index < BRIER_MIN_VOTES; index += 1) {
        matches.push(judgedMatch(index, [confidentVote('calibrated/judge', SOL, 0.8)]));
      }
      const [report] = analyzeJudgeCalibration(matches);
      expect(report!.agreementRate).toBe(1);
      expect(report!.brierScore).toBeCloseTo(0.04, 5);
      expect(report!.alert).toBe(false);

      const few = analyzeJudgeCalibration(matches.slice(0, 3));
      expect(few[0]!.scoredVotes).toBe(3);
      expect(few[0]!.alert).toBe(false);
    });

    it('scores only decisive votes on matches that produced a winner', () => {
      const abstained = judgedMatch(0, [vote('mixed/judge', SOL, FABLE, null)]);
      const noWinner = {
        ...judgedMatch(1, [confidentVote('mixed/judge', SOL, 0.9)]),
        winnerModelId: null,
      };
      const scored = judgedMatch(2, [confidentVote('mixed/judge', SOL, 0.6)]);
      const [report] = analyzeJudgeCalibration([abstained, noWinner, scored]);
      expect(report!.scoredVotes).toBe(1);
      expect(report!.brierScore).toBeCloseTo(0.16, 5);
    });
  });
});

describe('no-contest selection-bias analysis', () => {
  const voided = (index: number, flakyFails: boolean): MatchResult =>
    match({
      matchId: `match-nc-${index}`,
      scheduleIndex: index,
      responseA: flakyFails
        ? failure({ modelId: 'flaky/model' })
        : response({ modelId: 'flaky/model' }),
      responseB: response({ modelId: 'steady/model' }),
      outcome: flakyFails ? 'no-contest' : 'judged',
      winnerModelId: flakyFails ? null : 'steady/model',
      pointAwarded: !flakyFails,
    });

  it('alerts on a model whose failures void a large share of its matches', () => {
    const matches: MatchResult[] = [];
    for (let index = 0; index < NO_CONTEST_MIN_MATCHES; index += 1) {
      // 3 of 10 matches void on flaky/model's own failure.
      matches.push(voided(index, index < 3));
    }
    const reports = analyzeNoContestBias(matches);
    const flaky = reports.find((report) => report.modelId === 'flaky/model')!;
    expect(flaky.matches).toBe(NO_CONTEST_MIN_MATCHES);
    expect(flaky.ownFailures).toBe(3);
    expect(flaky.ownFailureRate).toBeCloseTo(0.3, 9);
    expect(flaky.voidedRate).toBeCloseTo(0.3, 9);
    expect(flaky.alert).toBe(true);

    const steady = reports.find((report) => report.modelId === 'steady/model')!;
    expect(steady.ownFailures).toBe(0);
    // The opponent is voided out of the same matches without failing itself.
    expect(steady.voidedMatches).toBe(3);
    expect(steady.alert).toBe(false);

    expect(formatNoContestBias(reports)).toContain('ALERT');
  });

  it('stays quiet below the match window and for clean journals', () => {
    const few = analyzeNoContestBias([voided(0, true), voided(1, true)]);
    expect(few.find((report) => report.modelId === 'flaky/model')!.alert).toBe(false);

    const clean = analyzeNoContestBias([voided(0, false)]);
    expect(clean.every((report) => !report.alert)).toBe(true);
    expect(formatNoContestBias(clean)).toBe('');
  });
});
