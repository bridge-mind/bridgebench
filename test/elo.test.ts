import { describe, expect, it } from 'vitest';

import { applyEloWin, ELO_INITIAL, expectedScore } from '../src/elo.js';

describe('Elo', () => {
  it('starts equal competitors at even expectation', () => {
    expect(expectedScore(ELO_INITIAL, ELO_INITIAL)).toBeCloseTo(0.5);
  });

  it('moves equal ratings by 16 points for a winner', () => {
    expect(applyEloWin(1000, 1000, 'a')).toEqual({ ratingA: 1016, ratingB: 984 });
  });

  it('conserves rating and rewards an upset more', () => {
    const upset = applyEloWin(1400, 1000, 'b');
    const favorite = applyEloWin(1400, 1000, 'a');
    expect(upset.ratingA + upset.ratingB).toBeCloseTo(2400);
    expect(upset.ratingB - 1000).toBeGreaterThan(favorite.ratingA - 1400);
  });
});
