import type { ArenaEvent, ArenaSnapshot, MatchResult } from '../../src/types';

export type BenchmarkCategory = 'reasoning' | 'hallucination';

export interface DashboardModel {
  id: string;
  displayName: string;
  vendor: string;
  role: 'competitor' | 'judge';
}

export interface DashboardTaskArtifact {
  id: string;
  type: 'code' | 'log' | 'config' | 'spec' | 'diff' | 'table' | 'note';
  label: string;
  content: string;
}

/** The public half of a task — exactly the context competitors receive. */
export interface DashboardTask {
  id: string;
  version: string;
  category: BenchmarkCategory;
  title: string;
  cluster: string;
  difficulty: 'hard' | 'expert';
  summary: string;
  prompt: string;
  artifacts: DashboardTaskArtifact[];
  tags: string[];
  publicHash: string;
}

export interface DashboardRun {
  status: 'idle' | 'running' | 'completed' | 'budget-stopped' | 'failed';
  config: { category: BenchmarkCategory; seed: string; matches: number; maxCostUsd: number; resume: boolean } | null;
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completed: number;
  total: number;
  costUsd: number;
  currentMatch: {
    matchId?: string;
    index?: number;
    total?: number;
    category?: BenchmarkCategory;
    taskId?: string;
    taskTitle?: string;
    modelA?: string;
    modelB?: string;
  } | null;
  error: string | null;
}

/** One category's arena: its task pack and its independent Elo ladder. */
export interface DashboardArena {
  meta: { label: string; tagline: string };
  tasks: DashboardTask[];
  snapshot: ArenaSnapshot;
}

export interface DashboardState {
  run: DashboardRun;
  hasApiKey: boolean;
  models: DashboardModel[];
  categories: BenchmarkCategory[];
  arenas: Record<BenchmarkCategory, DashboardArena>;
  events: ArenaEvent[];
}

export async function fetchState(): Promise<DashboardState> {
  const response = await fetch('/api/state', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Dashboard state failed (${response.status})`);
  return response.json() as Promise<DashboardState>;
}

export async function startArenaRun(config: {
  category: BenchmarkCategory;
  seed: string;
  matches: number;
  maxCostUsd: number;
  resume: boolean;
}): Promise<void> {
  const response = await fetch('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Run request failed (${response.status})`);
}

export type { ArenaEvent, MatchResult };
