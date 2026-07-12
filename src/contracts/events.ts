import type { BenchmarkCategory } from './categories.js';

interface ResponseSummary {
  success: boolean;
  latencyMs: number;
  costUsd: number;
  outputTokens: number;
  reasoningTokens: number | null;
}

export interface ArenaEventDataMap {
  'run.started': {
    runId: string;
    category: BenchmarkCategory;
    seed: string;
    matches: number;
    maxCostUsd: number;
    competitorIds: string[];
  };
  'match.started': {
    matchId: string;
    index: number;
    total: number;
    category: BenchmarkCategory;
    taskId: string;
    taskTitle: string;
    modelA: string;
    modelB: string;
  };
  'competitor.delta': {
    matchId: string;
    modelId: string;
    side: 'A' | 'B';
    text: string;
    done: boolean;
    success: boolean;
  };
  'competitors.completed': {
    matchId: string;
    modelA: ResponseSummary;
    modelB: ResponseSummary;
  };
  'judging.started': {
    matchId: string;
    judges: string[];
  };
  'judge.completed': {
    matchId: string;
    judgeModelId: string;
    anonymousWinner: 'MODEL_A' | 'MODEL_B' | null;
    votedFor: string | null;
    confidence: number | null;
    valid: boolean;
    error: string | null;
  };
  'match.completed': {
    matchId: string;
    taskId: string;
    winnerModelId: string | null;
    outcome: 'judged' | 'forfeit' | 'no-contest';
    costUsd: number;
    eloAfter: Record<string, number>;
    completed: number;
    total: number;
  };
  'run.budget-stopped': {
    runId: string;
    completed: number;
    costUsd: number;
    maxCostUsd: number;
  };
  'run.cancellation-requested': {
    runId: string;
    completed: number;
    costUsd: number;
  };
  'run.cancelled': {
    runId: string;
    completed: number;
    costUsd: number;
  };
  'run.completed': {
    runId: string;
    completed: number;
    costUsd: number;
    stoppedForBudget: boolean;
  };
  'run.failed': {
    error: string;
  };
}

export type ArenaEventType = keyof ArenaEventDataMap;

export type ArenaEvent = {
  [Type in ArenaEventType]: {
    id: string;
    type: Type;
    timestamp: string;
    data: ArenaEventDataMap[Type];
  };
}[ArenaEventType];

export type ArenaEventInput = {
  [Type in ArenaEventType]: Omit<Extract<ArenaEvent, { type: Type }>, 'timestamp'>;
}[ArenaEventType];

export type ArenaEventSink = (event: ArenaEvent) => void;
