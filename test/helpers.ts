import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyEloWin, ELO_INITIAL } from '../src/elo.js';
import { ArenaStore } from '../src/store.js';
import type {
  BenchmarkCategory,
  ChatRequest,
  CompleteArenaTask,
  CompetitorFailure,
  CompetitorSuccess,
  JudgeVote,
  MatchResult,
  ModelCompletion,
  ModelRegistryEntry,
  OpenRouterGateway,
  PanelDecision,
  TaskPrivate,
  TaskPublic,
} from '../src/types.js';

const MODEL_A = 'openai/gpt-5.6-sol';
const MODEL_B = 'anthropic/claude-fable-5';

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function makePublicTask(overrides: Partial<TaskPublic> = {}): TaskPublic {
  return {
    id: 'fixture-task',
    version: '1.0.0',
    category: 'reasoning',
    cluster: 'stateful-execution',
    difficulty: 'expert',
    title: 'Fixture task',
    summary: 'A deterministic task used only by offline tests.',
    prompt: '1. Determine the supported conclusion from the artifact.',
    artifacts: [
      {
        id: 'fixture-spec',
        type: 'spec',
        label: 'Fixture specification',
        content: 'The supported conclusion is alpha.',
      },
    ],
    tags: ['fixture'],
    ...overrides,
  };
}

export function makePrivateTask(
  publicTask: TaskPublic,
  overrides: Partial<TaskPrivate> = {},
): TaskPrivate {
  return {
    id: publicTask.id,
    version: publicTask.version,
    expectedResolution: 'The supported conclusion is alpha.',
    requiredEvidence: [publicTask.artifacts[0]!.id],
    disqualifyingErrors: ['Claiming the conclusion is beta.'],
    rubric: {
      correctness: 'Matches the supported conclusion.',
      evidenceGrounding: 'Cites the fixture specification.',
      constraintHandling: 'Uses only supplied evidence.',
      completeness: 'Answers the numbered deliverable.',
    },
    ...overrides,
  };
}

export function makeTask(
  publicOverrides: Partial<TaskPublic> = {},
  privateOverrides: Partial<TaskPrivate> = {},
): CompleteArenaTask {
  const publicTask = makePublicTask(publicOverrides);
  const privateTask = makePrivateTask(publicTask, privateOverrides);
  return {
    public: publicTask,
    private: privateTask,
    publicHash: hash(publicTask),
    privateHash: hash(privateTask),
  };
}

export function makeCompletion(
  content = 'Grounded fixture response.',
  overrides: Partial<ModelCompletion> = {},
): ModelCompletion {
  return {
    generationId: 'gen-fixture',
    content,
    inputTokens: 100,
    outputTokens: 50,
    reasoningTokens: 20,
    costUsd: 0.01,
    latencyMs: 10_000,
    finishReason: 'stop',
    ...overrides,
  };
}

export function makeSuccess(
  modelId = MODEL_A,
  content = 'Grounded fixture response.',
  overrides: Partial<ModelCompletion> = {},
): CompetitorSuccess {
  return {
    modelId,
    success: true,
    ...makeCompletion(content, overrides),
  };
}

export function makeFailure(
  modelId = MODEL_A,
  error = 'fixture transport failure',
  overrides: Partial<Omit<CompetitorFailure, 'modelId' | 'success' | 'error'>> = {},
): CompetitorFailure {
  return {
    modelId,
    success: false,
    error,
    latencyMs: 100,
    ...overrides,
  };
}

export function makeVote(
  judgeModelId: string,
  winnerModelId: string | null,
  modelA = MODEL_A,
  modelB = MODEL_B,
): JudgeVote {
  const winner = winnerModelId === modelA ? 'MODEL_A' : 'MODEL_B';
  return {
    judgeModelId,
    modelAIdentity: modelA,
    modelBIdentity: modelB,
    verdict:
      winnerModelId === null
        ? null
        : {
            winner,
            confidence: 0.9,
            rationale: 'The selected fixture response is stronger.',
            criteria: {
              correctness: 'Correct.',
              grounding: 'Grounded.',
              constraintHandling: 'Constrained.',
              completeness: 'Complete.',
            },
            violations: [],
            decisiveDifference: {
              deliverableId: 'd1',
              winnerClaim: 'Named the supported conclusion alpha.',
              loserError: 'Claimed the conclusion is beta.',
              artifactIds: ['fixture-spec'],
              rubricCriterion: 'correctness' as const,
            },
            abstainReason: null,
          },
    winnerModelId,
    completion:
      winnerModelId === null
        ? null
        : makeCompletion(JSON.stringify({ winner }), {
            generationId: `gen-${judgeModelId}`,
            costUsd: 0.001,
          }),
    ...(winnerModelId === null ? { error: 'fixture abstention' } : {}),
  };
}

export function makePanel(
  winners: Array<string | null> = [MODEL_A, MODEL_A, MODEL_A],
  modelA = MODEL_A,
  modelB = MODEL_B,
): PanelDecision {
  const votes = winners.map((winner, index) =>
    makeVote(`fixture/judge-${index + 1}`, winner, modelA, modelB),
  );
  const votesByModel = {
    [modelA]: winners.filter((winner) => winner === modelA).length,
    [modelB]: winners.filter((winner) => winner === modelB).length,
  };
  const winnerModelId = Object.entries(votesByModel).find(([, count]) => count >= 2)?.[0] ?? null;
  const winnerVotes = winnerModelId ? (votesByModel[winnerModelId] ?? 0) : 0;
  return {
    winnerModelId,
    validVotes: winners.filter((winner) => winner !== null).length,
    votesByModel,
    agreement: winnerVotes === 3 ? 'unanimous' : winnerVotes === 2 ? 'split' : 'insufficient',
    votes,
  };
}

export function makeMatch(overrides: Partial<MatchResult> = {}): MatchResult {
  const responseA = makeSuccess(MODEL_A);
  const responseB = makeSuccess(MODEL_B);
  const panel = makePanel();
  const update = applyEloWin(ELO_INITIAL, ELO_INITIAL, 'a');
  return {
    methodologyVersion: 'arena-v0.3.0',
    runId: 'run-fixture',
    matchId: 'match-fixture',
    scheduleIndex: 0,
    seed: 'fixture-seed',
    timestamp: '2026-07-11T00:00:00.000Z',
    task: {
      id: 'fixture-task',
      version: '1.0.0',
      category: 'reasoning',
      cluster: 'stateful-execution',
      publicHash: 'public-fixture',
      privateHash: 'private-fixture',
    },
    competitors: { modelA: MODEL_A, modelB: MODEL_B, responseA, responseB },
    outcome: 'judged',
    winnerModelId: MODEL_A,
    panel,
    eloBefore: { [MODEL_A]: ELO_INITIAL, [MODEL_B]: ELO_INITIAL },
    eloAfter: { [MODEL_A]: update.ratingA, [MODEL_B]: update.ratingB },
    pointAwarded: true,
    matchCostUsd:
      responseA.costUsd +
      responseB.costUsd +
      panel.votes.reduce((sum, vote) => sum + (vote.completion?.costUsd ?? 0), 0),
    ...overrides,
  };
}

export function createTestStore(
  root: string,
  category: BenchmarkCategory = 'reasoning',
): ArenaStore {
  return new ArenaStore({
    category,
    journalPath: path.join(root, 'journal.jsonl'),
    snapshotPath: path.join(root, 'snapshot.json'),
    markdownPath: path.join(root, 'leaderboard.md'),
    runsDir: path.join(root, 'runs'),
  });
}

export async function withTempStore<T>(
  callback: (store: ArenaStore, root: string) => Promise<T> | T,
  category: BenchmarkCategory = 'reasoning',
): Promise<T> {
  return withTempDir(
    (root) => callback(createTestStore(root, category), root),
    'bridgebench-store-',
  );
}

export async function withTempDir<T>(
  callback: (root: string) => Promise<T> | T,
  prefix = 'bridgebench-test-',
): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export class FixtureGateway implements OpenRouterGateway {
  readonly requests: ChatRequest[] = [];

  constructor(
    private readonly completeHandler: (
      request: ChatRequest,
      call: number,
    ) => ModelCompletion | Promise<ModelCompletion>,
  ) {}

  async validateModel(_model: ModelRegistryEntry): Promise<void> {}

  async complete(request: ChatRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    return this.completeHandler(request, this.requests.length);
  }
}
