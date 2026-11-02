/** Languages that have a command-line verifier in this package. */
export type Language = "go" | "python" | "rust";

/** Everything `languageForPath` can name. TypeScript is checked by `createTsChecker`, not here. */
export type VerifyLanguage = Language | "typescript" | "unknown";

export interface VerifyError {
  /** 1-based line in the candidate file (or in the other file, when `message` is prefixed with its path). */
  line: number;
  message: string;
}

export interface VerifyOptions {
  /** Absolute path of the real workspace. Only read, never written. */
  workspace: string;
  /** Absolute path of the file the candidate replaces. Must be inside `workspace`. */
  file: string;
  /** The full proposed text of `file`. */
  candidateText: string;
  /** Errors that already existed before the candidate. Matching messages are not reported again. */
  originalErrors?: readonly VerifyError[];
  /** Overrides the per-language default timeout, in milliseconds. */
  timeoutMs?: number;
  /** Directory in which the scratch copy is created. Defaults to the OS temp directory. */
  tempRoot?: string;
}

export interface VerifyResult {
  language: VerifyLanguage;
  /** False when the toolchain is missing, the check timed out, or its output could not be parsed. */
  available: boolean;
  errors: VerifyError[];
  reason?: string;
}
