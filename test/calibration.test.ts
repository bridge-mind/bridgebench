import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  CALIBRATION_VARIANTS,
  calibrationPassSet,
  defaultCalibrationRoot,
  inflateResponse,
  loadGoldCases,
  readCalibrationLedger,
  recordCalibration,
  runCalibration,
  type GoldCase,
} from '../src/calibration.js';
import type {
  ChatRequest,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
} from '../src/types.js';

const JUDGE_ID = 'google/gemini-3.1-pro-preview';

const tempDir = mkdtempSync(path.join(tmpdir(), 'bb-calibration-'));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

function verdictJson(winner: 'MODEL_A' | 'MODEL_B', artifactId: string): string {
  return JSON.stringify({
    winner,
    confidence: 0.85,
    rationale: 'Calibration fixture rationale.',
    criteria: {
      correctness: 'Checked.',
      grounding: 'Checked.',
      constraintHandling: 'Checked.',
      completeness: 'Checked.',
    },
    violations: [],
    decisiveDifference: {
      deliverableId: 'd1',
      winnerClaim: 'Matches the reference.',
      loserError: 'Contradicts the reference.',
      artifactIds: [artifactId],
      rubricCriterion: 'correctness',
    },
    abstainReason: null,
  });
}

/** Picks the response that contains STRONG-MARKER — a "perfect" judge. */
class MarkerGateway implements OpenRouterGateway {
  requests: ChatRequest[] = [];

  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const payload = JSON.parse(request.user) as {
      task: { artifacts: Array<{ id: string }> };
      modelA: { response: string };
      modelB: { response: string };
    };
    const winner = payload.modelA.response.includes('STRONG-MARKER') ? 'MODEL_A' : 'MODEL_B';
    return {
      generationId: 'gen-cal',
      content: verdictJson(winner, payload.task.artifacts[0]!.id),
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.001,
      latencyMs: 1,
      finishReason: 'stop',
      attempts: 1,
    };
  }
}

/** Always picks its anonymous seat A — a maximally position-biased judge. */
class SeatAGateway implements OpenRouterGateway {
  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    const payload = JSON.parse(request.user) as { task: { artifacts: Array<{ id: string }> } };
    return {
      generationId: 'gen-seat-a',
      content: verdictJson('MODEL_A', payload.task.artifacts[0]!.id),
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.001,
      latencyMs: 1,
      finishReason: 'stop',
      attempts: 1,
    };
  }
}

function goldCase(id = 'cal-fixture-case'): GoldCase {
  return {
    id,
    task: {
      public: {
        id,
        version: '1.0.0',
        category: 'reasoning',
        cluster: 'stateful-execution',
        difficulty: 'hard',
        title: 'Fixture case',
        summary: 'A fixture gold case for calibration tests.',
        prompt: 'Answer the deliverable.',
        artifacts: [
          { id: 'artifact-1', type: 'note', label: 'Note', content: 'The answer is 42.' },
        ],
        tags: [],
      },
      private: {
        id,
        version: '1.0.0',
        expectedResolution: 'The answer is 42.',
        requiredEvidence: ['artifact-1'],
        disqualifyingErrors: [],
        rubric: {
          correctness: 'Must be 42.',
          evidenceGrounding: 'Must cite artifact-1.',
          constraintHandling: 'None.',
          completeness: 'One deliverable.',
        },
      },
    },
    strongResponse: 'STRONG-MARKER The answer is 42, per artifact-1.',
    weakResponse: 'The answer is 41, from memory.',
    knownDifference: 'Strong matches the reference; weak contradicts it.',
  };
}

describe('gold set loading', () => {
  it('loads the shipped calibration set with valid schemas and unique ids', async () => {
    const cases = await loadGoldCases(defaultCalibrationRoot());
    expect(cases.length).toBeGreaterThanOrEqual(7);
    const categories = new Set(cases.map((entry) => entry.task.public.category));
    for (const category of [
      'reasoning',
      'hallucination',
      'security',
      'bullshit',
      'refactoring',
      'debugging',
      'generation',
    ]) {
      expect(categories.has(category as never)).toBe(true);
    }
    for (const entry of cases) {
      expect(entry.task.public.id).toBe(entry.id);
      expect(entry.strongResponse).not.toEqual(entry.weakResponse);
    }
  });
});

describe('inflateResponse', () => {
  it('adds verbosity without touching the substantive content', () => {
    const original = 'The answer is 42.';
    const inflated = inflateResponse(original);
    expect(inflated).toContain(original);
    expect(inflated.length).toBeGreaterThan(original.length * 5);
  });
});

describe('runCalibration', () => {
  it('passes a judge that tracks substance across every variant', async () => {
    const gateway = new MarkerGateway();
    const report = await runCalibration(gateway, JUDGE_ID, [goldCase()]);
    expect(report.passed).toBe(true);
    expect(report.passRate).toBe(1);
    expect(report.seatConsistency).toBe(1);
    expect(report.verbosityResistance).toBe(1);
    expect(report.variantsRun).toBe(CALIBRATION_VARIANTS.length);
    // Both seat orders were actually presented.
    const seatAFirst = gateway.requests.filter((request) =>
      (JSON.parse(request.user) as { modelA: { response: string } }).modelA.response.includes(
        'STRONG-MARKER',
      ),
    );
    expect(seatAFirst).toHaveLength(2);
  });

  it('fails a seat-biased judge and reports seat inconsistency', async () => {
    const report = await runCalibration(new SeatAGateway(), JUDGE_ID, [goldCase()]);
    expect(report.passed).toBe(false);
    // Seat-A picks are right when strong sits in A, wrong when it sits in B.
    expect(report.passRate).toBe(0.5);
    expect(report.seatConsistency).toBe(0);
    expect(report.caseResults[0]!.verbosityResistant).toBe(false);
  });
});

describe('calibration ledger', () => {
  it('records reports per judge and exposes the passing set', async () => {
    const ledgerPath = path.join(tempDir, 'calibration.json');
    const passing = await runCalibration(new MarkerGateway(), JUDGE_ID, [goldCase()]);
    recordCalibration(passing, ledgerPath);
    const failing = await runCalibration(new SeatAGateway(), 'x-ai/grok-4.5', [goldCase()]);
    recordCalibration(failing, ledgerPath);

    const ledger = readCalibrationLedger(ledgerPath);
    expect(Object.keys(ledger).sort()).toEqual(['google/gemini-3.1-pro-preview', 'x-ai/grok-4.5']);
    expect(calibrationPassSet(ledger)).toEqual(new Set([JUDGE_ID]));
    // Re-recording overwrites in place rather than appending.
    recordCalibration(passing, ledgerPath);
    expect(
      Object.keys(JSON.parse(readFileSync(ledgerPath, 'utf8')) as Record<string, unknown>),
    ).toHaveLength(2);
  });
});
