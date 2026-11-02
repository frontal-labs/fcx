export { openIndex, IndexStore } from "./store.js";
export { indexWorkspace } from "./indexer.js";
export { IndexError, type IndexErrorCode } from "./errors.js";
export { SCHEMA_VERSION } from "./schema.js";
export { FILE_EDGE_KINDS, SYMBOL_EDGE_KINDS } from "./types.js";
export type {
  Embedder,
  EdgeInput,
  EdgeKind,
  FileEdgeKind,
  FileInput,
  FileNeighbor,
  FileRecord,
  IndexSummary,
  IndexWorkspaceOptions,
  Neighbor,
  SearchHit,
  SymbolEdgeKind,
  SymbolInput,
  SymbolKind,
  SymbolRecord,
  VectorHit,
} from "./types.js";
