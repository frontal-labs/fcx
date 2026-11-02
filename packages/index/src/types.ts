/** Kinds of symbols stored in the `symbols` table (plan section 8.1). */
export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "var"
  | "module"
  | "test";

/**
 * Stored edge kinds. Symbol-level kinds connect `symbols.id` values; file-level kinds connect
 * `files.id` values. `defines` is not stored because `symbols.file_id` already records it.
 */
export type SymbolEdgeKind = "calls" | "references" | "implements" | "tests";

export type FileEdgeKind = "imports" | "co_changes";

export type EdgeKind = SymbolEdgeKind | FileEdgeKind;

export const SYMBOL_EDGE_KINDS: readonly SymbolEdgeKind[] = [
  "calls",
  "references",
  "implements",
  "tests",
];

export const FILE_EDGE_KINDS: readonly FileEdgeKind[] = ["imports", "co_changes"];

export interface FileRecord {
  readonly id: number;
  readonly path: string;
  readonly lang: string | null;
  readonly hash: string;
  readonly mtime: number;
  readonly size: number;
}

export interface FileInput {
  readonly path: string;
  readonly lang: string | null;
  readonly hash: string;
  readonly mtime: number;
  readonly size: number;
}

export interface SymbolRecord {
  readonly id: number;
  readonly fileId: number;
  readonly name: string;
  readonly qualified: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc: string;
  readonly exported: boolean;
}

export interface SymbolInput {
  readonly name: string;
  readonly qualified: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc: string;
  readonly exported: boolean;
  /** Text stored in `chunks.text` and indexed by FTS5. */
  readonly chunkText: string;
  /** Approximate token count of `chunkText`. */
  readonly tokens: number;
}

export interface EdgeInput {
  readonly src: number;
  readonly dst: number;
  readonly kind: EdgeKind;
  readonly weight: number;
}

export interface Neighbor {
  readonly symbolId: number;
  readonly kind: SymbolEdgeKind;
  readonly weight: number;
  /** `out` when the given symbol is `src`, `in` when it is `dst`. */
  readonly direction: "out" | "in";
}

export interface FileNeighbor {
  readonly fileId: number;
  readonly kind: FileEdgeKind;
  readonly weight: number;
  readonly direction: "out" | "in";
}

export interface SearchHit {
  readonly chunkId: number;
  readonly symbolId: number;
  /** Higher is better. This is the negated FTS5 `bm25()` value. */
  readonly score: number;
}

export interface VectorHit {
  readonly chunkId: number;
  readonly symbolId: number;
  /** Cosine similarity, higher is better. */
  readonly score: number;
}

/** Optional embedding model. When absent, no vectors are written. */
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

export interface IndexWorkspaceOptions {
  /** Path of the SQLite database file. Created when missing. */
  readonly dbPath: string;
  /** Extra exclusion globs, matched against workspace-relative POSIX paths. */
  readonly exclude?: readonly string[];
  /** Optional embedding model. Indexing works without it. */
  readonly embedder?: Embedder;
  /** Where the Go extractor binary is built and cached. Defaults to `~/.cache/fcx/go-extract`. */
  readonly goCacheDir?: string;
}

export interface IndexSummary {
  readonly filesScanned: number;
  readonly filesChanged: number;
  readonly filesRemoved: number;
  readonly ms: number;
  /** Non-fatal problems, for example an embedding batch that failed. */
  readonly warnings: readonly string[];
}
