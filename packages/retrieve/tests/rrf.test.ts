import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../src/rrf.js";

describe("reciprocalRankFusion", () => {
  it("scores each symbol as the sum of 1 / (60 + rank) over the lists", () => {
    // Rank 1 in list A and rank 2 in list B.
    const fused = reciprocalRankFusion([
      [10, 20, 30],
      [30, 10],
    ]);
    const byId = new Map(fused.map((hit) => [hit.symbolId, hit.score]));
    expect(byId.get(10)).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(byId.get(30)).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(byId.get(20)).toBeCloseTo(1 / 62, 12);
  });

  it("orders by score, then by symbol id for equal scores", () => {
    const fused = reciprocalRankFusion([[7], [3]]);
    expect(fused.map((hit) => hit.symbolId)).toEqual([3, 7]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61, 12);
  });

  it("counts a repeated entry once and gives it no rank of its own", () => {
    const fused = reciprocalRankFusion([[5, 5, 6]]);
    const byId = new Map(fused.map((hit) => [hit.symbolId, hit.score]));
    expect(byId.get(5)).toBeCloseTo(1 / 61, 12);
    expect(byId.get(6)).toBeCloseTo(1 / 62, 12);
  });

  it("uses a custom k when given", () => {
    const fused = reciprocalRankFusion([[1]], 0);
    expect(fused[0]?.score).toBe(1);
  });

  it("returns nothing for no lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
