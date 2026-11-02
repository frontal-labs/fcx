import { FILE_EDGE_KINDS, type IndexStore, SYMBOL_EDGE_KINDS, type SymbolRecord } from "@fcx/index";
import { FILE_NEIGHBOR_SYMBOL_CAP, MIN_EDGE_WEIGHT } from "./constants.js";
import type { GraphEdge, GraphPort } from "./graph.js";

/**
 * Symbols a file-level edge leads to: exported symbols first, then by line, capped. Modules are
 * skipped because they span the whole file.
 */
function representativeSymbols(store: IndexStore, fileId: number): SymbolRecord[] {
  return store
    .symbolsInFile(fileId)
    .filter((symbol) => symbol.kind !== "module")
    .sort(
      (a, b) => Number(b.exported) - Number(a.exported) || a.startLine - b.startLine || a.id - b.id,
    )
    .slice(0, FILE_NEIGHBOR_SYMBOL_CAP);
}

/**
 * Index-backed graph. Symbol edges (`calls`, `references`, `implements`, `tests`) connect symbols
 * directly. File edges (`imports`, `co_changes`) are expanded to the representative symbols of
 * the neighboring file. Both use the weight threshold from the plan.
 */
export function storeGraph(store: IndexStore): GraphPort {
  return {
    neighbors(symbolId: number): readonly GraphEdge[] {
      const merged = new Map<number, GraphEdge>();
      const offer = (edge: GraphEdge): void => {
        if (edge.symbolId === symbolId) {
          return;
        }
        const current = merged.get(edge.symbolId);
        if (current === undefined || edge.weight > current.weight) {
          merged.set(edge.symbolId, edge);
        }
      };
      for (const neighbor of store.neighbors(symbolId, SYMBOL_EDGE_KINDS, MIN_EDGE_WEIGHT)) {
        offer({ symbolId: neighbor.symbolId, kind: neighbor.kind, weight: neighbor.weight });
      }
      const symbol = store.symbolById(symbolId);
      if (symbol !== undefined) {
        for (const neighbor of store.neighborFiles(
          symbol.fileId,
          FILE_EDGE_KINDS,
          MIN_EDGE_WEIGHT,
        )) {
          for (const target of representativeSymbols(store, neighbor.fileId)) {
            offer({ symbolId: target.id, kind: neighbor.kind, weight: neighbor.weight });
          }
        }
      }
      return [...merged.values()].sort((a, b) => a.symbolId - b.symbolId);
    },
    label(symbolId: number): string {
      return store.symbolById(symbolId)?.qualified ?? `symbol ${symbolId}`;
    },
  };
}
