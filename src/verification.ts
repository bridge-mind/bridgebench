import { applyEloWin, ELO_INITIAL } from './elo.js';
import { counterbalancedSwap } from './judges.js';
import { runIdFromManifest, runManifestHash, type RunManifest } from './run-manifest.js';
import {
  JUDGE_ADJUDICATION_RESERVES,
  JUDGE_PANEL_SIZE,
  seatPanel,
  seatReserves,
  vendorOf,
} from './seating.js';
import { isLiveResponse, speedMetricFor, speedWinner } from './speed.js';
import {
  METHODOLOGY_VERSION,
  competitorCost,
  supportsExhibitionMatches,
  type BenchmarkCategory,
  type EloState,
  type MatchResult,
  type PanelDecision,
  type SpeedMetric,
  type SpeedMetrics,
} from './types.js';

const LEGACY_METHODOLOGY_VERSION = 'reasoning-arena-v0.2.0';
// Journals from the fixed three-judge-panel era. arena-v0.4.0 onward seats
// each match's panel from the manifest's judge pool (see seating.ts), so
// panel-membership rules are gated on the journal line's version.
const FIXED_PANEL_METHODOLOGY_VERSIONS = new Set([LEGACY_METHODOLOGY_VERSION, 'arena-v0.3.0']);
// arena-v0.5.0 adds TIE/ABSTAIN verdicts and best-of-5 adaptive adjudication;
// earlier eras hold a fixed three-vote panel with a >=2 majority. arena-v0.6.0
// keeps those verdict rules and adds the ranked/exhibition split.
const ADJUDICATION_METHODOLOGY_VERSIONS = new Set(['arena-v0.5.0', METHODOLOGY_VERSION]);
const SUPPORTED_METHODOLOGY_VERSIONS = new Set([
  ...FIXED_PANEL_METHODOLOGY_VERSIONS,
  'arena-v0.4.0',
  'arena-v0.5.0',
  METHODOLOGY_VERSION,
]);
const EPSILON = 1e-9;

function usesSeatedPanels(methodologyVersion: string): boolean {
  return !FIXED_PANEL_METHODOLOGY_VERSIONS.has(methodologyVersion);
}

function usesAdjudication(methodologyVersion: string): boolean {
  return ADJUDICATION_METHODOLOGY_VERSIONS.has(methodologyVersion);
}

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
  methodologyVersion: string,
): {
  winnerModelId: string | null;
  validVotes: number;
  votesByModel: Record<string, number>;
  agreement: PanelDecision['agreement'];
  tieVotes: number;
} {
  const votesByModel: Record<string, number> = { [modelA]: 0, [modelB]: 0 };
  let validVotes = 0;
  let tieVotes = 0;
  for (const vote of panel.votes) {
    if (vote.winnerModelId === null) {
      if (vote.verdict?.winner === 'TIE') tieVotes += 1;
      continue;
    }
    if (vote.winnerModelId !== modelA && vote.winnerModelId !== modelB) {
      fail(`judge ${vote.judgeModelId} resolved an unknown competitor`);
    }
    validVotes += 1;
    votesByModel[vote.winnerModelId] = (votesByModel[vote.winnerModelId] ?? 0) + 1;
  }
  // arena-v0.5.0: a winner needs a strict majority of the SEATED panel
  // (floor(n/2)+1), and 'unanimous' means every seated judge voted for it.
  // Earlier eras hold a fixed three-vote panel with the historical >=2 rule.
  // The two coincide when n === 3.
  const seated = panel.votes.length;
  const majority = usesAdjudication(methodologyVersion) ? Math.floor(seated / 2) + 1 : 2;
  const winnerModelId =
    Object.entries(votesByModel).find(([, count]) => count >= majority)?.[0] ?? null;
  const winnerVotes = winnerModelId ? (votesByModel[winnerModelId] ?? 0) : 0;
  const agreement: PanelDecision['agreement'] = usesAdjudication(methodologyVersion)
    ? winnerModelId === null
      ? 'insufficient'
      : winnerVotes === seated
        ? 'unanimous'
        : 'split'
    : winnerVotes === 3
      ? 'unanimous'
      : winnerVotes === 2
        ? 'split'
        : 'insufficient';
  return { winnerModelId, validVotes, votesByModel, agreement, tieVotes };
}

function verifyPanel(
  panel: PanelDecision,
  modelA: string,
  modelB: string,
  methodologyVersion: string,
): string | null {
  const expected = expectedPanel(panel, modelA, modelB, methodologyVersion);
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
  if (usesAdjudication(methodologyVersion)) {
    if (panel.tieVotes !== undefined && panel.tieVotes !== expected.tieVotes) {
      fail(`panel tieVotes expected ${expected.tieVotes}, found ${panel.tieVotes}`);
    }
    if (panel.adjudicated !== undefined && panel.adjudicated !== panel.votes.length > 3) {
      fail(
        `panel adjudicated flag ${panel.adjudicated} contradicts a ${panel.votes.length}-vote panel`,
      );
    }
  }
  return expected.winnerModelId;
}

/**
 * Re-check every vote's `verdict.winner` label → `winnerModelId` resolution
 * through the recorded per-judge seat permutation. Each vote journals which
 * real competitor sat in its anonymous seats (`modelAIdentity` /
 * `modelBIdentity`); a tampered `winnerModelId` that no longer follows from
 * the judge's own label is caught here regardless of era or pool knowledge.
 */
function verifyVoteResolution(panel: PanelDecision, modelA: string, modelB: string): void {
  for (const vote of panel.votes) {
    const identities = [vote.modelAIdentity, vote.modelBIdentity];
    if (
      vote.modelAIdentity === vote.modelBIdentity ||
      !identities.includes(modelA) ||
      !identities.includes(modelB)
    ) {
      fail(
        `judge ${vote.judgeModelId} seat identities [${identities.join(', ')}] must be a permutation of the competitors`,
      );
    }
    const label = vote.verdict?.winner ?? null;
    const resolved =
      label === 'MODEL_A' ? vote.modelAIdentity : label === 'MODEL_B' ? vote.modelBIdentity : null;
    if (vote.winnerModelId !== resolved) {
      fail(
        `judge ${vote.judgeModelId} winnerModelId ${vote.winnerModelId ?? 'none'} does not resolve from its ${label ?? 'null'} verdict through the recorded seat permutation`,
      );
    }
  }
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
 * one with the lower recorded totalMs. An exact millisecond tie voids the match
 * since arena-v0.5.0 (earlier journals resolved ties to the scheduled modelA).
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
    const tieVoids = usesAdjudication(match.methodologyVersion);
    const expectedWinner = tieVoids
      ? speedWinner(derived, modelA, modelB)
      : (speedWinner(derived, modelA, modelB) ?? modelA);
    return {
      expectedOutcome: expectedWinner === null ? 'no-contest' : 'speed-decided',
      expectedWinner,
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

function verifyOutcome(match: MatchResult, warn: (message: string) => void): void {
  const { modelA, modelB, responseA, responseB } = match.competitors;
  if (modelA === modelB) fail('a competitor cannot face itself');
  if (responseA.modelId !== modelA || responseB.modelId !== modelB) {
    fail('competitor response identity does not match its scheduled side');
  }

  // Forfeit scoring was retired mid-arena-v0.4.0 (2026-07-14): a failed
  // response now voids the match. Journals from the current methodology can
  // never legitimately contain one; earlier eras keep their historical shape
  // but the mixed scoring is surfaced as a warning.
  if (match.outcome === 'forfeit') {
    if (usesAdjudication(match.methodologyVersion)) {
      fail(
        `forfeit outcomes were retired before ${match.methodologyVersion} — a failed response voids the match as a no-contest`,
      );
    }
    warn(
      `Run ${match.runId} contains legacy forfeit outcomes (pre-2026-07-14 scoring); its ladder mixes forfeit-era and no-contest-era rules.`,
    );
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
    // Pool-independent seated-panel integrity: this is the only rotation
    // check a manifest-less journal gets, so it must never be skipped.
    if (usesSeatedPanels(match.methodologyVersion)) {
      const voteJudges = match.panel.votes.map((vote) => vote.judgeModelId);
      if (usesAdjudication(match.methodologyVersion)) {
        // Adjudication era: a primary panel of 3 may escalate by seating up
        // to JUDGE_ADJUDICATION_RESERVES extra judges from the same ordering.
        const maxSeats = JUDGE_PANEL_SIZE + JUDGE_ADJUDICATION_RESERVES;
        if (voteJudges.length < JUDGE_PANEL_SIZE || voteJudges.length > maxSeats) {
          fail(
            `a seated panel must hold between ${JUDGE_PANEL_SIZE} and ${maxSeats} votes, found ${voteJudges.length}`,
          );
        }
      } else if (voteJudges.length !== JUDGE_PANEL_SIZE) {
        fail(
          `a seated panel must hold exactly ${JUDGE_PANEL_SIZE} votes, found ${voteJudges.length}`,
        );
      }
      if (new Set(voteJudges).size !== voteJudges.length) {
        fail('a seated panel cannot hold duplicate judges');
      }
      const conflicted = new Set([vendorOf(modelA), vendorOf(modelB)]);
      for (const judgeId of voteJudges) {
        if (conflicted.has(vendorOf(judgeId))) {
          fail(`judge ${judgeId} shares a vendor with a competitor it judged`);
        }
      }
    }
    verifyVoteResolution(match.panel, modelA, modelB);
    expectedWinner = verifyPanel(match.panel, modelA, modelB, match.methodologyVersion);
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
  // The ranked/exhibition split is a run-level property: every journal line
  // must agree with its manifest so a single line cannot flip itself out of
  // (or into) the ladder.
  if ((match.ranked !== false) !== (manifest.ranked !== false)) {
    fail('journal line ranked flag does not match the run manifest');
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
  // Rotation-era exact seating: re-derive the panel from the MANIFEST's pool
  // (never the live registry, so future pool changes cannot break old
  // journals). Pre-adjudication journals must hold exactly the seated trio;
  // arena-v0.5.0 journals hold either the primary trio or the trio plus every
  // available reserve (escalation is all-or-nothing), matching the recorded
  // adjudicated flag.
  if (match.panel && usesSeatedPanels(match.methodologyVersion)) {
    const poolIds = manifest.judges.map((model) => model.id);
    const competitors = [match.competitors.modelA, match.competitors.modelB];
    const primary = seatPanel(poolIds, competitors, match.seed, match.matchId);
    const voteJudges = match.panel.votes.map((vote) => vote.judgeModelId);
    const voteSet = new Set(voteJudges);

    if (usesAdjudication(match.methodologyVersion) && voteJudges.length > JUDGE_PANEL_SIZE) {
      const reserves = seatReserves(poolIds, competitors, match.seed, match.matchId);
      const expected = [...primary, ...reserves];
      if (
        voteJudges.length !== expected.length ||
        expected.some((judgeId) => !voteSet.has(judgeId))
      ) {
        fail(
          `an adjudicated panel must hold exactly the seated judges and reserves [${expected.join(', ')}] for match ${match.matchId}, found [${voteJudges.join(', ')}]`,
        );
      }
    } else {
      const seated = new Set(primary);
      for (const judgeId of voteJudges) {
        if (!seated.has(judgeId)) {
          fail(
            `judge ${judgeId} is not on the seated panel [${[...seated].join(', ')}] for match ${match.matchId}`,
          );
        }
      }
    }

    // Counterbalanced-seat replay (adjudication era): each vote's recorded
    // seat permutation must equal the deterministic assignment for that
    // judge's rank in the full potential panel (primaries then reserves), so
    // a rewritten permutation cannot smuggle a different resolution past the
    // label check in verifyVoteResolution.
    if (usesAdjudication(match.methodologyVersion)) {
      const reserves = seatReserves(poolIds, competitors, match.seed, match.matchId);
      const seatOrder = [...primary, ...reserves];
      for (const vote of match.panel.votes) {
        const seatIndex = seatOrder.indexOf(vote.judgeModelId);
        if (seatIndex === -1) continue; // membership already rejected above
        const expectedSeatA = counterbalancedSwap(match.matchId, seatIndex)
          ? match.competitors.modelB
          : match.competitors.modelA;
        if (vote.modelAIdentity !== expectedSeatA) {
          fail(
            `judge ${vote.judgeModelId} recorded ${vote.modelAIdentity} in seat A but the counterbalanced assignment for match ${match.matchId} seats ${expectedSeatA}`,
          );
        }
      }
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

      verifyOutcome(match, (message) => warnings.add(message));
      // Exhibition lines exist only from arena-v0.6.0: earlier versions have
      // no ranked field, and a backdated `ranked: false` would let a rewritten
      // journal skip Elo movement its era requires.
      if (match.ranked === false && !supportsExhibitionMatches(match.methodologyVersion)) {
        fail(`exhibition matches are not valid under ${match.methodologyVersion}`);
      }
      const ranked = match.ranked !== false;
      const { modelA, modelB } = match.competitors;
      const ratingA = ratings[modelA] ?? ELO_INITIAL;
      const ratingB = ratings[modelB] ?? ELO_INITIAL;
      assertRecordKeys(match.eloBefore, [modelA, modelB], 'eloBefore');
      assertRecordKeys(match.eloAfter, [modelA, modelB], 'eloAfter');
      equalNumber(match.eloBefore[modelA], ratingA, `eloBefore.${modelA}`);
      equalNumber(match.eloBefore[modelB], ratingB, `eloBefore.${modelB}`);

      // Exhibition matches keep their verdict but must not move the ladder or
      // award points — eloAfter is asserted equal to eloBefore below.
      let nextA = ratingA;
      let nextB = ratingB;
      if (match.winnerModelId && ranked) {
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
