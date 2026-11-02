import type ts from "typescript";

export interface Diagnostic {
  /** Absolute path of the file the diagnostic belongs to. */
  file: string;
  /** 1-based line and column. */
  line: number;
  column: number;
  code: number;
  message: string;
  category: "error" | "warning" | "suggestion" | "message";
}

export interface Checker {
  /** Diagnostics for `file`, with optional in-memory `overrides` (absolute path to text). Nothing is written to disk. */
  diagnostics(file: string, overrides?: ReadonlyMap<string, string>): Diagnostic[];
  /** The underlying language service, for retrieval (definitions, references). */
  readonly service: ts.LanguageService;
  /** The compiler options in effect. */
  readonly options: ts.CompilerOptions;
  dispose(): void;
}

export interface SearchReplace {
  search: string;
  replace: string;
}
