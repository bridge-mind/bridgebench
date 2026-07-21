import { describe, expect, it } from 'vitest';

import { buildSnapshot, renderMarkdown } from '../src/report.js';
import { makeMatch } from './helpers.js';

const WINNER = 'openai/gpt-5.6-sol';
const LOSER = 'anthropic/claude-fable-5';
const UNPLAYED = 'fixture/unplayed';

function snapshotWithUnplayed() {
  return buildSnapshot([makeMatch()], 'reasoning', {
    competitorIds: [UNPLAYED, LOSER, WINNER],
  });
}

describe('arena report ranking', () => {
  it('leaves every model unranked on an empty ladder', () => {
    const snapshot = buildSnapshot([], 'reasoning', {
      competitorIds: ['fixture/beta', 'fixture/alpha'],
    });

    expect(snapshot.version).toBe('0.3.0');
    expect(snapshot.leaderboard).toMatchObject([
      { modelId: 'fixture/alpha', rank: null, status: 'unranked', matches: 0 },
      { modelId: 'fixture/beta', rank: null, status: 'unranked', matches: 0 },
    ]);
  });

  it('places an unplayed model after a played pair without assigning it a rank', () => {
    const snapshot = snapshotWithUnplayed();

    expect(snapshot.leaderboard).toMatchObject([
      { modelId: WINNER, rank: 1, status: 'ranked', matches: 1 },
      { modelId: LOSER, rank: 2, status: 'ranked', matches: 1 },
      { modelId: UNPLAYED, rank: null, status: 'unranked', matches: 0 },
    ]);
  });

  it('keeps a tested 984-rated loser above an unplayed 1000-rated model', () => {
    const { leaderboard } = snapshotWithUnplayed();
    const loser = leaderboard.find((entry) => entry.modelId === LOSER);
    const unplayed = leaderboard.find((entry) => entry.modelId === UNPLAYED);

    expect(loser).toMatchObject({ elo: 984, rank: 2, status: 'ranked' });
    expect(unplayed).toMatchObject({ elo: 1000, rank: null, status: 'unranked' });
    expect(leaderboard.indexOf(loser!)).toBeLessThan(leaderboard.indexOf(unplayed!));
  });

  it('serializes the unranked status explicitly in snapshot API output', () => {
    const serialized = JSON.parse(JSON.stringify(snapshotWithUnplayed())) as ReturnType<
      typeof snapshotWithUnplayed
    >;

    expect(serialized.leaderboard.at(-1)).toMatchObject({
      modelId: UNPLAYED,
      rank: null,
      status: 'unranked',
    });
  });

  it('keeps exhibition-only models out of the ranked ladder', () => {
    const exhibition = makeMatch({
      methodologyVersion: 'arena-v0.6.0',
      ranked: false,
      eloAfter: { [WINNER]: 1000, [LOSER]: 1000 },
    });
    const snapshot = buildSnapshot([exhibition], 'reasoning', {
      competitorIds: [WINNER, LOSER],
    });

    expect(snapshot.matches).toHaveLength(1);
    expect(snapshot.leaderboard).toMatchObject([
      { modelId: LOSER, rank: null, status: 'unranked', matches: 0, points: 0 },
      { modelId: WINNER, rank: null, status: 'unranked', matches: 0, points: 0 },
    ]);
  });

  it('orders multiple unplayed models deterministically', () => {
    const first = buildSnapshot([], 'reasoning', {
      competitorIds: ['fixture/zulu', 'fixture/alpha', 'fixture/middle'],
    });
    const second = buildSnapshot([], 'reasoning', {
      competitorIds: ['fixture/middle', 'fixture/zulu', 'fixture/alpha'],
    });

    expect(first.leaderboard.map((entry) => entry.modelId)).toEqual([
      'fixture/alpha',
      'fixture/middle',
      'fixture/zulu',
    ]);
    expect(second.leaderboard).toEqual(first.leaderboard);
  });

  it('renders no numeric rank for an unplayed model', () => {
    const markdown = renderMarkdown(snapshotWithUnplayed());

    expect(markdown).toContain(`| — | ${UNPLAYED} | 1000.00 |`);
    expect(markdown).not.toContain(`| 3 | ${UNPLAYED} |`);
  });
});
