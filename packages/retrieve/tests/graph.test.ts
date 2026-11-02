import { describe, expect, it } from "vitest";
import { type GraphEdge, type GraphPort, expandGraph } from "../src/graph.js";

/** A synthetic graph: edges are listed per source and are used in both directions. */
function syntheticPort(edges: [number, number, string, number][]): GraphPort {
  return {
    neighbors(symbolId) {
      const out: GraphEdge[] = [];
      for (const [src, dst, kind, weight] of edges) {
        if (src === symbolId) out.push({ symbolId: dst, kind, weight });
        if (dst === symbolId) out.push({ symbolId: src, kind, weight });
      }
      return out.sort((a, b) => a.symbolId - b.symbolId);
    },
    label: (symbolId) => `s${symbolId}`,
  };
}

describe("expandGraph", () => {
  // Target 1 with score T = 0.03. Hit 8 with score 0.02.
  const edges: [number, number, string, number][] = [
    [1, 2, "calls", 1],
    [1, 4, "calls", 0.29], // below the threshold: never followed
    [1, 5, "calls", 0.3], // exactly at the threshold: followed
    [2, 3, "references", 0.5],
    [2, 1, "calls", 1], // back to the target: ignored
    [3, 6, "calls", 1], // three hops from the target: not reached
    [5, 7, "tests", 0.8],
    [8, 9, "imports", 1],
  ];
  const port = syntheticPort(edges);
  const hits = [{ symbolId: 8, score: 0.02, rank: 1 }];

  it("scores expanded nodes parent * 0.5^hops * edge_weight, exactly", () => {
    const reached = expandGraph(port, 1, 0.03, hits);
    const score = (id: number) => reached.get(id)?.score;
    expect(score(1)).toBe(0.03);
    expect(score(2)).toBeCloseTo(0.03 * 0.5 * 1, 12); // 0.015
    expect(score(5)).toBeCloseTo(0.03 * 0.5 * 0.3, 12); // 0.0045
    expect(score(3)).toBeCloseTo(0.015 * 0.5 * 0.5, 12); // 0.00375, two hops
    expect(score(7)).toBeCloseTo(0.0045 * 0.5 * 0.8, 12); // 0.0018, two hops
    expect(score(8)).toBe(0.02);
    expect(score(9)).toBeCloseTo(0.02 * 0.5 * 1, 12); // 0.01, one hop from the hit
  });

  it("reports hop counts and reasons", () => {
    const reached = expandGraph(port, 1, 0.03, hits);
    expect(reached.get(1)?.hops).toBe(0);
    expect(reached.get(2)?.hops).toBe(1);
    expect(reached.get(3)?.hops).toBe(2);
    expect(reached.get(7)?.hops).toBe(2);
    expect(reached.get(9)?.hops).toBe(1);
    expect(reached.get(8)?.why).toBe("ranked hit 1");
    expect(reached.get(3)?.why).toBe("references of s2");
  });

  it("does not follow edges below 0.3 and does not reach three hops", () => {
    const reached = expandGraph(port, 1, 0.03, hits);
    expect(reached.has(4)).toBe(false);
    expect(reached.has(6)).toBe(false);
  });

  it("keeps the higher score when a node is reached by two paths", () => {
    // Node 2 is a hit (0.5) and also a one-hop neighbor of the target (0.015).
    const reached = expandGraph(port, 1, 0.03, [{ symbolId: 2, score: 0.5, rank: 1 }]);
    expect(reached.get(2)?.score).toBe(0.5);
    expect(reached.get(2)?.hops).toBe(0);
  });

  it("expands hits one hop only", () => {
    const chain = syntheticPort([
      [8, 9, "calls", 1],
      [9, 10, "calls", 1],
    ]);
    const reached = expandGraph(chain, undefined, 0, [{ symbolId: 8, score: 0.02, rank: 1 }]);
    expect(reached.has(9)).toBe(true);
    expect(reached.has(10)).toBe(false);
  });

  it("returns only the hits when there is no target", () => {
    const reached = expandGraph(port, undefined, 0, hits);
    expect([...reached.keys()].sort((a, b) => a - b)).toEqual([8, 9]);
  });
});
