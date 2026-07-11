export const ELO_INITIAL = 1000;
export const ELO_K = 32;

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

export function applyEloWin(
  ratingA: number,
  ratingB: number,
  winner: 'a' | 'b',
): { ratingA: number; ratingB: number } {
  const expectedA = expectedScore(ratingA, ratingB);
  const scoreA = winner === 'a' ? 1 : 0;
  return {
    ratingA: ratingA + ELO_K * (scoreA - expectedA),
    ratingB: ratingB + ELO_K * (1 - scoreA - (1 - expectedA)),
  };
}
