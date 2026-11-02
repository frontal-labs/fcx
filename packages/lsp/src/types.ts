/**
 * Public types for the language server pool.
 *
 * Coordinates: lines and columns are 1-based, as in editors and compiler output.
 * Columns count UTF-16 code units, which is what LSP uses. Conversion to the
 * 0-based LSP positions happens inside the client.
 */

export type Language = "typescript" | "rust" | "go" | "python";

export const LANGUAGES: readonly Language[] = ["typescript", "rust", "go", "python"];

export interface Position {
  readonly line: number;
  readonly column: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export type DiagnosticSeverity = "error" | "warning" | "information" | "hint";

export interface Diagnostic {
  /** Absolute path of the file the diagnostic belongs to. */
  readonly file: string;
  readonly range: Range;
  readonly severity: DiagnosticSeverity;
  readonly code?: string;
  readonly source?: string;
  readonly message: string;
}

export interface Location {
  readonly file: string;
  readonly range: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

export interface FileEdits {
  readonly file: string;
  readonly edits: readonly TextEdit[];
}

/** Resource operations (create, rename or delete a file) that a rename may request. */
export interface ResourceOperation {
  readonly kind: "create" | "rename" | "delete";
  readonly file: string;
  readonly newFile?: string;
}

/** A WorkspaceEdit in plain form. Nothing in this package applies it to disk. */
export interface WorkspaceEdit {
  readonly files: readonly FileEdits[];
  readonly resourceOperations: readonly ResourceOperation[];
}

/** Why a request could not be answered by a language server. */
export interface UnavailableReason {
  readonly source: "unavailable";
  readonly language: Language | null;
  readonly reason: string;
}

export interface DiagnosticsResult {
  readonly source: "language-server";
  readonly language: Language;
  /** Diagnostics for every overlaid file and for the requested file. */
  readonly diagnostics: readonly Diagnostic[];
}

export type DiagnosticsOutcome = DiagnosticsResult | UnavailableReason;

export interface DefinitionResult {
  readonly source: "language-server";
  readonly language: Language;
  readonly locations: readonly Location[];
}

export type DefinitionOutcome = DefinitionResult | UnavailableReason;

export interface RenameResult {
  readonly source: "language-server";
  readonly language: Language;
  /** The edit to apply. The caller decides whether and how to write it. */
  readonly edit: WorkspaceEdit;
}

export type RenameOutcome = RenameResult | UnavailableReason;

/** How a language server is launched. */
export interface ServerCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment variables for the server process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Passed as `initializationOptions` in the LSP initialize request. */
  readonly initializationOptions?: Readonly<Record<string, unknown>>;
}

/** Where a detected binary was found. */
export type ServerSource = "workspace" | "repo" | "path";

export type DetectedServer =
  | {
      readonly language: Language;
      readonly available: true;
      readonly command: ServerCommand;
      readonly binaryPath: string;
      readonly source: ServerSource;
    }
  | {
      readonly language: Language;
      readonly available: false;
      readonly reason: string;
    };

export interface DetectOptions {
  /** Replaces `process.env.PATH` during detection. Tests use this to hide servers. */
  readonly pathEnv?: string;
  /**
   * Allow binaries and tsserver from the workspace's own node_modules. Off by default: a repository can
   * ship any executable there, so running it is code execution. Set this only when the workspace is trusted.
   */
  readonly trustWorkspace?: boolean;
}

export interface ServerExitInfo {
  readonly language: Language;
  readonly code: number | null;
  readonly signal: string | null;
  /** Last lines the server wrote to stderr, for diagnosis. */
  readonly stderrTail: string;
  /** Whether the pool will restart the server on the next request. */
  readonly willRestart: boolean;
}

export interface LanguageServerPoolOptions {
  /** Timeout for one overlay diagnostics check, from didOpen/didChange to publish. Default 10000. */
  readonly diagnosticsTimeoutMs?: number;
  /** Timeout for definition and rename requests. Default 15000. */
  readonly requestTimeoutMs?: number;
  /** Timeout for the initialize handshake. Default 60000. */
  readonly initializeTimeoutMs?: number;
  /**
   * Quiet period after the first publish for a file. Servers may send one
   * publish per diagnostic kind, so the pool waits this long for more before
   * answering. Default 150.
   */
  readonly settleMs?: number;
  /**
   * After a publish that was empty, a check whose result is also empty may produce no publish at
   * all (typescript-language-server does this). The pool then waits this long and reports the
   * previous empty state. Default 500.
   */
  /** Unexpected exits allowed before the pool stops restarting a server. Default 1. */
  readonly maxRestarts?: number;
  /** Replaces detection for a language. Used by tests and by custom servers. */
  readonly servers?: Readonly<Partial<Record<Language, ServerCommand>>>;
  readonly detect?: DetectOptions;
  /** Called when a server process exits unexpectedly. */
  readonly onServerExit?: (info: ServerExitInfo) => void;
}
