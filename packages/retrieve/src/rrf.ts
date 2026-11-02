import { RRF_K } from "./constants.js";

export interface FusedHit {
  readonly symbolId: number;
  readonly score: number;
}

/**
 * Reciprocal rank fusion (plan section 8.3): `score = sum over lists of 1 / (k + rank)`, with
 * rank 1-based over the distinct entries of each list. A repeated entry is ignored. The result
 * is sorted by score descending, then symbol id ascending, so it does not depend on Map order.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly number[])[],
  k: number = RRF_K,
): FusedHit[] {
  const scores = new Map<number, number>();
  for (const list of lists) {
    const seen = new Set<number>();
    let rank = 0;
    for (const symbolId of list) {
      if (seen.has(symbolId)) {
        continue;
      }
      seen.add(symbolId);
      rank += 1;
      scores.set(symbolId, (scores.get(symbolId) ?? 0) + 1 / (k + rank));
    }
  }
  return [...scores]
    .map(([symbolId, score]) => ({ symbolId, score }))
    .sort((a, b) => b.score - a.score || a.symbolId - b.symbolId);
}
