import { applyEloWin, ELO_INITIAL } from './elo.js';
import { runIdFromManifest, runManifestHash, type RunManifest } from './run-manifest.js';
import { isLiveResponse, speedMetricFor, speedWinner } from './speed.js';
import {
  METHODOLOGY_VERSION,
  competitorCost,
  type BenchmarkCategory,
  type EloState,
  type MatchResult,
  type PanelDecision,
  type SpeedMetric,
  type SpeedMetrics,
} from './types.js';

const LEGACY_METHODOLOGY_VERSION = 'reasoning-arena-v0.2.0';
const SUPPORTED_METHODOLOGY_VERSIONS = new Set([LEGACY_METHODOLOGY_VERSION, METHODOLOGY_VERSION]);
const EPSILON = 1e-9;

export interface VerificationOptions {
  manifestForRun?: (runId: string) => RunManifest | null;
  requireManifests?: boolean;
}

export interface VerifiedJournal {
  category: BenchmarkCategory;
  methodologyVersion: string | null;
  matches: MatchResult[];
  ratings: Record<string, number>;
  points: Record<string, number>;
  runs: string[];
  warnings: string[];
}

function fail(message: string): never {
  throw new Error(message);
}

function equalNumber(actual: number | undefined, expected: number, label: string): void {
  if (actual === undefined || Math.abs(actual - expected) > EPSILON) {
    fail(`${label} expected ${expected}, found ${actual ?? '<missing>'}`);
  }
}

function assertRecordKeys(record: Record<string, number>, expected: string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} keys must be exactly ${wanted.join(', ')}`);
  }
}

function expectedPanel(
  panel: PanelDecision,
  modelA: string,
  modelB: string,
): {
  winnerModelId: string | null;
  validVotes: number;
  votesByModel: Record<string, number>;
  agreement: PanelDecision['agreement'];
} {
  const votesByModel: Record<string, number> = { [modelA]: 0, [modelB]: 0 };
  let validVotes = 0;
  for (const vote of panel.votes) {
    if (vote.winnerModelId === null) continue;
    if (vote.winnerModelId !== modelA && vote.winnerModelId !== modelB) {
      fail(`judge ${vote.judgeModelId} resolved an unknown competitor`);
    }
    validVotes += 1;
    votesByModel[vote.winnerModelId] = (votesByModel[vote.winnerModelId] ?? 0) + 1;
  }
  const winnerModelId = Object.entries(votesByModel).find(([, count]) => count >= 2)?.[0] ?? null;
  const winnerVotes = winnerModelId ? (votesByModel[winnerModelId] ?? 0) : 0;
  return {
    winnerModelId,
    validVotes,
    votesByModel,
    agreement: winnerVotes === 3 ? 'unanimous' : winnerVotes === 2 ? 'split' : 'insufficient',
  };
}

function verifyPanel(panel: PanelDecision, modelA: string, modelB: string): string | null {
  const expected = expectedPanel(panel, modelA, modelB);
  if (panel.validVotes !== expected.validVotes) {
    fail(`panel validVotes expected ${expected.validVotes}, found ${panel.validVotes}`);
  }
  assertRecordKeys(panel.votesByModel, [modelA, modelB], 'panel votesByModel');
  equalNumber(
    panel.votesByModel[modelA],
    expected.votesByModel[modelA] ?? 0,
    `votes for ${modelA}`,
  );
  equalNumber(
    panel.votesByModel[modelB],
    expected.votesByModel[modelB] ?? 0,
    `votes for ${modelB}`,
  );
  if (panel.winnerModelId !== expected.winnerModelId) {
    fail(
      `panel winner expected ${expected.winnerModelId ?? 'none'}, found ${panel.winnerModelId ?? 'none'}`,
    );
  }
  if (panel.agreement !== expected.agreement) {
    fail(`panel agreement expected ${expected.agreement}, found ${panel.agreement}`);
  }
  return expected.winnerModelId;
}

function assertSpeedMetric(actual: SpeedMetric, expected: SpeedMetric, side: 'a' | 'b'): void {
  equalNumber(actual.ttftMs, expected.ttftMs, `speedMetrics.${side}.ttftMs`);
  equalNumber(actual.totalMs, expected.totalMs, `speedMetrics.${side}.totalMs`);
  equalNumber(actual.outputTokens, expected.outputTokens, `speedMetrics.${side}.outputTokens`);
  equalNumber(actual.tps, expected.tps, `speedMetrics.${side}.tps`);
}

/**
 * Re-derive a speed match's outcome and winner offline. A speed line is decided
 * by liveness and latency, never by a panel, so this replaces the judged/forfeit
 * logic entirely for the speed category. Two live competitors must record
 * speedMetrics that match the responses' own timings, and the winner must be the
 * one with the lower recorded totalMs.
 */
function expectedSpeedOutcome(
  match: MatchResult,
  modelA: string,
  modelB: string,
): { expectedOutcome: MatchResult['outcome']; expectedWinner: string | null } {
  const { responseA, responseB } = match.competitors;
  if (isLiveResponse(responseA) && isLiveResponse(responseB)) {
    if (!match.speedMetrics) {
      fail('a speed-decided match must record speedMetrics for both competitors');
    }
    const derived: SpeedMetrics = {
      a: speedMetricFor(responseA),
      b: speedMetricFor(responseB),
    };
    assertSpeedMetric(match.speedMetrics.a, derived.a, 'a');
    assertSpeedMetric(match.speedMetrics.b, derived.b, 'b');
    return {
      expectedOutcome: 'speed-decided',
      expectedWinner: speedWinner(derived, modelA, modelB),
    };
  }
  if (match.speedMetrics != null) {
    fail('a speed forfeit or no-contest must not record speedMetrics');
  }
  const aLive = isLiveResponse(responseA);
  const bLive = isLiveResponse(responseB);
  if (aLive !== bLive) {
    // Current rule: a dead side voids the match. Journals written before
    // 2026-07-14 recorded these as forfeit wins — still verifiable.
    if (match.outcome === 'forfeit') {
      return { expectedOutcome: 'forfeit', expectedWinner: aLive ? modelA : modelB };
    }
    return { expectedOutcome: 'no-contest', expectedWinner: null };
  }
  return { expectedOutcome: 'no-contest', expectedWinner: null };
}

function verifyOutcome(match: MatchResult): void {
  const { modelA, modelB, responseA, responseB } = match.competitors;
  if (modelA === modelB) fail('a competitor cannot face itself');
  if (responseA.modelId !== modelA || responseB.modelId !== modelB) {
    fail('competitor response identity does not match its scheduled side');
  }

  let expectedWinner: string | null = null;
  let expectedOutcome: MatchResult['outcome'];
  if (match.task.category === 'speed') {
    if (match.panel !== null) fail('a speed match must not contain a judge panel');
    ({ expectedOutcome, expectedWinner } = expectedSpeedOutcome(match, modelA, modelB));
  } else if (responseA.success !== responseB.success) {
    if (match.panel !== null) fail('a failed response must not contain a judge panel');
    // Current rule: a failed response voids the match (no winner, no point,
    // no Elo). Journals written before 2026-07-14 recorded these as forfeit
    // wins for the surviving side — that legacy shape still verifies.
    if (match.outcome === 'forfeit') {
      expectedOutcome = 'forfeit';
      expectedWinner = responseA.success ? modelA : modelB;
    } else {
      expectedOutcome = 'no-contest';
    }
  } else if (!responseA.success && !responseB.success) {
    expectedOutcome = 'no-contest';
    if (match.panel !== null) fail('double failure must not contain a judge panel');
  } else {
    if (match.panel === null) fail('two successful responses require a judge panel');
    expectedWinner = verifyPanel(match.panel, modelA, modelB);
    expectedOutcome = expectedWinner ? 'judged' : 'no-contest';
  }

  if (match.outcome !== expectedOutcome) {
    fail(`outcome expected ${expectedOutcome}, found ${match.outcome}`);
  }
  if (match.winnerModelId !== expectedWinner) {
    fail(`winner expected ${expectedWinner ?? 'none'}, found ${match.winnerModelId ?? 'none'}`);
  }
  if (match.pointAwarded !== (expectedWinner !== null)) {
    fail(`pointAwarded must be ${expectedWinner !== null}`);
  }

  const judgeCost =
    match.panel?.votes.reduce((sum, vote) => sum + (vote.completion?.costUsd ?? 0), 0) ?? 0;
  equalNumber(
    match.matchCostUsd,
    competitorCost(responseA) + competitorCost(responseB) + judgeCost,
    'matchCostUsd',
  );
}

function verifyManifest(
  match: MatchResult,
  manifest: RunManifest,
  category: BenchmarkCategory,
): void {
  const hash = runManifestHash(manifest);
  if (match.runManifestHash !== hash) {
    fail(`run manifest hash expected ${hash}, found ${match.runManifestHash ?? '<missing>'}`);
  }
  if (match.runId !== runIdFromManifest(manifest)) {
    fail(`runId does not match the canonical run manifest`);
  }
  if (
    manifest.category !== category ||
    manifest.seed !== match.seed ||
    manifest.methodologyVersion !== match.methodologyVersion
  ) {
    fail('run manifest category, seed, or methodology does not match the journal line');
  }
  if (match.scheduleIndex >= manifest.matches) {
    fail(`scheduleIndex ${match.scheduleIndex} exceeds manifest match count ${manifest.matches}`);
  }
  const competitorIds = new Set(manifest.competitors.map((model) => model.id));
  if (
    !competitorIds.has(match.competitors.modelA) ||
    !competitorIds.has(match.competitors.modelB)
  ) {
    fail('journal competitor is absent from the run manifest');
  }
  const task = manifest.tasks.find((candidate) => candidate.id === match.task.id);
  if (
    !task ||
    task.version !== match.task.version ||
    task.publicHash !== match.task.publicHash ||
    task.privateHash !== match.task.privateHash
  ) {
    fail(`task ${match.task.id} does not match the run manifest`);
  }
  const judgeIds = new Set(manifest.judges.map((model) => model.id));
  for (const vote of match.panel?.votes ?? []) {
    if (!judgeIds.has(vote.judgeModelId)) {
      fail(`judge ${vote.judgeModelId} is absent from the run manifest`);
    }
  }
}

export function verifyJournal(
  input: MatchResult[],
  category: BenchmarkCategory,
  options: VerificationOptions = {},
): VerifiedJournal {
  const ratings: Record<string, number> = {};
  const points: Record<string, number> = {};
  const matches: MatchResult[] = [];
  const matchIds = new Set<string>();
  const runs = new Set<string>();
  const lastScheduleIndex = new Map<string, number>();
  const manifestHashes = new Map<string, string>();
  const warnings = new Set<string>();
  let methodologyVersion: string | null = null;

  for (const [offset, original] of input.entries()) {
    const line = offset + 1;
    try {
      if (!SUPPORTED_METHODOLOGY_VERSIONS.has(original.methodologyVersion)) {
        fail(`unsupported methodology version ${original.methodologyVersion}`);
      }
      methodologyVersion ??= original.methodologyVersion;
      if (methodologyVersion !== original.methodologyVersion) {
        fail(`mixed methodology versions ${methodologyVersion} and ${original.methodologyVersion}`);
      }
      const match: MatchResult = {
        ...original,
        task: {
          ...original.task,
          category: original.task.category ?? category,
        },
      };
      if (match.task.category !== category) {
        fail(`task category ${match.task.category} does not match ${category}`);
      }
      if (matchIds.has(match.matchId)) fail(`duplicate matchId ${match.matchId}`);
      matchIds.add(match.matchId);

      const previousIndex = lastScheduleIndex.get(match.runId);
      if (previousIndex !== undefined && match.scheduleIndex <= previousIndex) {
        fail(`scheduleIndex ${match.scheduleIndex} is not increasing within run ${match.runId}`);
      }
      lastScheduleIndex.set(match.runId, match.scheduleIndex);
      runs.add(match.runId);

      if (match.runManifestHash) {
        const priorHash = manifestHashes.get(match.runId);
        if (priorHash && priorHash !== match.runManifestHash) {
          fail(`run ${match.runId} references multiple manifest hashes`);
        }
        manifestHashes.set(match.runId, match.runManifestHash);
        const manifest = options.manifestForRun?.(match.runId) ?? null;
        if (manifest) {
          verifyManifest(match, manifest, category);
        } else if (options.requireManifests) {
          fail(`run manifest ${match.runId}.json is required but missing`);
        } else {
          warnings.add(`Run ${match.runId} references a manifest that was not supplied.`);
        }
      } else {
        warnings.add(`Run ${match.runId} is a legacy journal without a manifest hash.`);
      }

      verifyOutcome(match);
      const { modelA, modelB } = match.competitors;
      const ratingA = ratings[modelA] ?? ELO_INITIAL;
      const ratingB = ratings[modelB] ?? ELO_INITIAL;
      assertRecordKeys(match.eloBefore, [modelA, modelB], 'eloBefore');
      assertRecordKeys(match.eloAfter, [modelA, modelB], 'eloAfter');
      equalNumber(match.eloBefore[modelA], ratingA, `eloBefore.${modelA}`);
      equalNumber(match.eloBefore[modelB], ratingB, `eloBefore.${modelB}`);

      let nextA = ratingA;
      let nextB = ratingB;
      if (match.winnerModelId) {
        const update = applyEloWin(ratingA, ratingB, match.winnerModelId === modelA ? 'a' : 'b');
        nextA = update.ratingA;
        nextB = update.ratingB;
        points[match.winnerModelId] = (points[match.winnerModelId] ?? 0) + 1;
      }
      equalNumber(match.eloAfter[modelA], nextA, `eloAfter.${modelA}`);
      equalNumber(match.eloAfter[modelB], nextB, `eloAfter.${modelB}`);
      ratings[modelA] = nextA;
      ratings[modelB] = nextB;
      matches.push(match);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Journal line ${line}: ${reason}`, { cause: error });
    }
  }

  return {
    category,
    methodologyVersion,
    matches,
    ratings,
    points,
    runs: [...runs],
    warnings: [...warnings],
  };
}

export function verifiedEloState(matches: MatchResult[], category: BenchmarkCategory): EloState {
  const verified = verifyJournal(matches, category);
  return { ratings: verified.ratings, points: verified.points };
}
