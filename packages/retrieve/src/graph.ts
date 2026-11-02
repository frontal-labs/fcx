import { HOP_DECAY, MIN_EDGE_WEIGHT } from "./constants.js";

/** One usable edge out of a symbol. Neighbors are expected in a stable order. */
export interface GraphEdge {
  readonly symbolId: number;
  readonly kind: string;
  readonly weight: number;
}

/** The graph operations expansion needs. The index-backed implementation is in store-graph.ts. */
export interface GraphPort {
  neighbors(symbolId: number): readonly GraphEdge[];
  label(symbolId: number): string;
}

/** A ranked hit entering expansion. `rank` is its 1-based position after fusion. */
export interface SeedHit {
  readonly symbolId: number;
  readonly score: number;
  readonly rank: number;
}

export interface Reached {
  readonly symbolId: number;
  readonly score: number;
  /** Hops from the hit or target this node was reached by, on its best path. */
  readonly hops: number;
  readonly why: string;
}

/**
 * Graph expansion (plan section 8.3, step 5). Every hit expands one hop. The target expands
 * two hops along its own chain, so the second hop is scored from the first. An expanded
 * node scores `parent * 0.5 * edge_weight`. Edges lighter than MIN_EDGE_WEIGHT are ignored. A node
 * reached several ways keeps its highest score, and among equal scores its fewest hops.
 */
export function expandGraph(
  graph: GraphPort,
  target: number | undefined,
  targetScore: number,
  hits: readonly SeedHit[],
): Map<number, Reached> {
  const reached = new Map<number, Reached>();
  const offer = (symbolId: number, score: number, hops: number, why: string): void => {
    // The target is a seed with a fixed score; it is never re-scored by a path.
    if (symbolId === target && hops > 0) {
      return;
    }
    const current = reached.get(symbolId);
    if (
      current === undefined ||
      score > current.score ||
      (score === current.score && hops < current.hops)
    ) {
      reached.set(symbolId, { symbolId, score, hops, why });
    }
  };
  const usable = (symbolId: number, source: number): GraphEdge[] =>
    graph
      .neighbors(symbolId)
      .filter((edge) => edge.symbolId !== source && edge.weight >= MIN_EDGE_WEIGHT);

  for (const hit of hits) {
    offer(hit.symbolId, hit.score, 0, `ranked hit ${hit.rank}`);
  }

  if (target !== undefined) {
    offer(target, targetScore, 0, "target symbol");
    // The target walks two hops along its own chain: target -> first -> second.
    for (const first of usable(target, target)) {
      const firstScore = targetScore * HOP_DECAY * first.weight;
      offer(first.symbolId, firstScore, 1, `${first.kind} of ${graph.label(target)}`);
      for (const second of usable(first.symbolId, target)) {
        offer(
          second.symbolId,
          firstScore * HOP_DECAY * second.weight,
          2,
          `${second.kind} of ${graph.label(first.symbolId)}`,
        );
      }
    }
  }

  for (const hit of hits) {
    if (hit.symbolId === target) {
      continue;
    }
    for (const edge of usable(hit.symbolId, hit.symbolId)) {
      offer(
        edge.symbolId,
        hit.score * HOP_DECAY * edge.weight,
        1,
        `${edge.kind} of ${graph.label(hit.symbolId)}`,
      );
    }
  }

  return reached;
}
