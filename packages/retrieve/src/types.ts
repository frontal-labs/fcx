import type { Embedder } from "@fcx/index";
import type { Checker } from "@fcx/verify";

export interface ContextBlock {
  /** Workspace-relative path. */
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  /** Why the block is included, for the prompt and for logs. */
  why: string;
}

export interface FixContext {
  enclosing: ContextBlock | null;
  definitions: ContextBlock[];
}

export interface GatherOptions {
  checker: Checker;
  workspace: string;
  /** Absolute path of the file that has the diagnostic. */
  file: string;
  line: number;
  column: number;
  /** Character budget for all blocks. Roughly `contextBudgetTokens * 3`. */
  budgetChars?: number;
}

/** A context block with the score it was packed by. */
export interface ScoredContextBlock extends ContextBlock {
  readonly score: number;
}

/** What the caller knows about the work: a location, a symbol name, and the texts it came from. */
export interface RetrieveTask {
  /** Workspace root. Relative file paths are resolved against it. */
  readonly workspace: string;
  /** Diagnostic or cursor file, workspace-relative or absolute. */
  readonly file?: string;
  /** 1-based line in `file`. With `file`, selects the innermost symbol containing it. */
  readonly line?: number;
  /** Symbol name or qualified name. Used when `file` and `line` do not select a symbol. */
  readonly symbol?: string;
  /** Diagnostic message or stack trace. Its identifiers feed the query; the text is a required block. */
  readonly errorText?: string;
  /** Selected code. Its identifiers feed the query. */
  readonly selection?: string;
  /** The user's natural-language request. */
  readonly text?: string;
}

export interface RetrieveOptions {
  /** Index database path. Created by `indexWorkspace` when missing. */
  readonly dbPath: string;
  /** Optional embedding model. Without it the vector side is skipped and reported. */
  readonly embedder?: Embedder;
  /** Token budget for packed blocks. Defaults to `DEFAULT_CONTEXT_BUDGET_TOKENS`. */
  readonly contextBudgetTokens?: number;
  /** Extra exclusion globs passed to `indexWorkspace`. */
  readonly exclude?: readonly string[];
  /** Skip the incremental index refresh and query the index as it is. */
  readonly skipIndex?: boolean;
}

export interface AllowLists {
  /** Workspace-relative paths of the files in the bundle. */
  readonly paths: readonly string[];
  /** Qualified names of the symbols whose blocks are in the bundle. */
  readonly symbolsInScope: readonly string[];
  /** Packages declared in the workspace's package.json. */
  readonly importablePackages: readonly string[];
}

export interface BundleMetadata {
  /** True when the vector side contributed to the ranking. */
  readonly vectorSide: boolean;
  readonly budgetTokens: number;
  readonly usedTokens: number;
  /** Candidate blocks that did not fit the budget, or could not be read. */
  readonly droppedBlocks: number;
  /** False when no symbol matched the task. The bundle then holds only the error text, if any. */
  readonly targetFound: boolean;
  /** Human-readable notes: skipped vector side, index warnings, and similar. */
  readonly notes: readonly string[];
}

export interface ContextBundle {
  readonly blocks: readonly ScoredContextBlock[];
  readonly allowLists: AllowLists;
  readonly metadata: BundleMetadata;
}
