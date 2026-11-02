export const DEFAULT_BUDGET_CHARS = 9000;

export const MAX_ENCLOSING_LINES = 120;

export const MAX_DEFINITION_LINES = 6;

export const MAX_DEFINITIONS = 8;

/** Default `contextBudgetTokens` for `retrieve`. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 4000;

/** Characters per token, the approximation from plan section 8.3 (`ceil(chars / 3.5)`). */
export const CHARS_PER_TOKEN = 3.5;

/** Reciprocal rank fusion constant (plan section 8.3). */
export const RRF_K = 60;

/** Hits taken from the FTS side and from the vector side before fusion. */
export const BM25_LIMIT = 50;
export const VECTOR_LIMIT = 50;

/** Fused hits kept before graph expansion, in addition to the target seed. */
export const FUSED_LIMIT = 10;

/** Edges lighter than this are not followed (plan section 8.3). */
export const MIN_EDGE_WEIGHT = 0.3;

/** Score multiplier per hop: an expanded node scores `parent * 0.5 * edge_weight`. */
export const HOP_DECAY = 0.5;

/** Nodes at or beyond this many hops are packed as their signature, not their full body. */
export const SIGNATURE_MIN_HOPS = 2;

/** Symbols taken from a file reached over a file-level edge (`imports`, `co_changes`). */
export const FILE_NEIGHBOR_SYMBOL_CAP = 3;
