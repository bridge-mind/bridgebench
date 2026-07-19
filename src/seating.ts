import { createHash } from 'node:crypto';

/**
 * Deterministic per-match judge seating.
 *
 * A judge never sits on a match where it — or any model from its vendor —
 * competes. The seated panel is a pure function of (pool, competitors,
 * runSeed, matchId), so the engine, offline verification, and the API each
 * re-derive it independently and byte-identically. No RNG: seating is
 * replay-stable and resume-safe.
 */

export const JUDGE_PANEL_SIZE = 3;
/**
 * Extra judges seated when a primary panel cannot produce a clean unanimous
 * verdict (split vote, tie-majority, or abstention). Ranks 4..5 of the same
 * deterministic ordering, so adjudication is replay-stable too.
 */
export const JUDGE_ADJUDICATION_RESERVES = 2;

/**
 * Judges with a reviewed, passing gold-calibration record (see
 * calibration.ts / `arena calibrate`). Seating ranks calibrated judges ahead
 * of uncalibrated ones, so new pool members serve as adjudication reserves
 * until they earn primary seats.
 *
 * This is a versioned code constant — NOT a live read of the calibration
 * ledger — because seating must stay a pure function of committed code plus
 * (pool, competitors, seed, matchId): the engine, offline verification, and
 * the API all re-derive panels independently and none of them can see a
 * mutable ledger file. Promote a judge here (with the ledger run that
 * justifies it) in the same change that ships it.
 *
 * The five arena-v0.4.0 pool members are grandfathered as calibrated: they
 * predate the gold sets, and keeping them ranked first preserves every
 * historical panel derivation byte-for-byte when the pool grows.
 */
export const CALIBRATED_JUDGE_IDS: ReadonlySet<string> = new Set([
  'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.5',
  'z-ai/glm-5.2',
  'openai/gpt-5.6-sol',
  'moonshotai/kimi-k2.7-code',
]);

/** A match that cannot seat a full conflict-free panel refuses to run. */
export class SeatingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatingError';
  }
}

/**
 * A model's vendor for conflict-of-interest purposes: the OpenRouter id
 * prefix. Every registry entry's `vendor` field equals this prefix — a test
 * asserts that invariant so a future divergence fails loudly instead of
 * silently mis-excluding.
 */
export function vendorOf(modelId: string): string {
  const separator = modelId.indexOf('/');
  return separator === -1 ? modelId : modelId.slice(0, separator);
}

/** Pool members allowed to judge this pairing: no shared vendor with either competitor. */
export function eligibleJudgeIds(
  poolIds: readonly string[],
  competitorIds: readonly string[],
): string[] {
  const conflicted = new Set(competitorIds.map(vendorOf));
  return poolIds.filter((judgeId) => !conflicted.has(vendorOf(judgeId)));
}

function seatRank(runSeed: string, matchId: string, judgeId: string): string {
  return createHash('sha256').update(`${runSeed}|${matchId}|${judgeId}`).digest('hex');
}

/**
 * The full deterministic seat ordering of every eligible judge for a match.
 * The primary sort key is calibration: judges in `calibratedIds` outrank the
 * rest, so uncalibrated pool additions only ever sit as adjudication reserves
 * (or fill primary seats when conflicts leave fewer than three calibrated
 * judges eligible). Within each calibration class, the hash rank applies; its
 * keys are independent of pool input order, and ties (practically impossible
 * for sha256) break on the judge id so determinism is absolute. Ranks 0..2
 * are the primary panel; ranks 3..4 are the adjudication reserves.
 *
 * When every eligible judge is calibrated — true of every pool up to and
 * including arena-v0.4.0's five — this ordering is identical to the plain
 * hash ordering, so historical panel derivations are unchanged.
 */
export function rankEligibleJudges(
  poolIds: readonly string[],
  competitorIds: readonly string[],
  runSeed: string,
  matchId: string,
  calibratedIds: ReadonlySet<string> = CALIBRATED_JUDGE_IDS,
): string[] {
  return eligibleJudgeIds(poolIds, competitorIds)
    .map((judgeId) => ({
      judgeId,
      calibrated: calibratedIds.has(judgeId) ? 0 : 1,
      rank: seatRank(runSeed, matchId, judgeId),
    }))
    .sort((left, right) => {
      if (left.calibrated !== right.calibrated) return left.calibrated - right.calibrated;
      return left.rank === right.rank
        ? left.judgeId.localeCompare(right.judgeId)
        : left.rank.localeCompare(right.rank);
    })
    .map(({ judgeId }) => judgeId);
}

/**
 * Seat a match's primary panel: the first three of the deterministic ordering.
 * Throws SeatingError when the pool cannot cover the pairing — callers must
 * fail closed before any paid work.
 */
export function seatPanel(
  poolIds: readonly string[],
  competitorIds: readonly string[],
  runSeed: string,
  matchId: string,
): string[] {
  const ranked = rankEligibleJudges(poolIds, competitorIds, runSeed, matchId);
  if (ranked.length < JUDGE_PANEL_SIZE) {
    throw new SeatingError(
      `Match ${matchId} cannot seat ${JUDGE_PANEL_SIZE} judges: a pool of ${poolIds.length} leaves ${ranked.length} eligible after excluding the vendors of ${competitorIds.join(', ')}`,
    );
  }
  return ranked.slice(0, JUDGE_PANEL_SIZE);
}

/**
 * Adjudication reserves: ranks 4..5 of the same ordering. May return fewer
 * than JUDGE_ADJUDICATION_RESERVES (or none) when the eligible pool is thin —
 * escalation then proceeds with whatever reserves exist.
 */
export function seatReserves(
  poolIds: readonly string[],
  competitorIds: readonly string[],
  runSeed: string,
  matchId: string,
): string[] {
  return rankEligibleJudges(poolIds, competitorIds, runSeed, matchId).slice(
    JUDGE_PANEL_SIZE,
    JUDGE_PANEL_SIZE + JUDGE_ADJUDICATION_RESERVES,
  );
}
