export interface Edit {
  /** Path relative to the workspace root (absolute paths are accepted and normalized). */
  file: string;
  /** Text to find. Must match exactly once in the file at the point it is applied. */
  search: string;
  replace: string;
}

export type EditErrorCode = "ANCHOR_NOT_FOUND" | "ANCHOR_NOT_UNIQUE" | "EMPTY_SEARCH";

export interface PlannedFile {
  /** Absolute path. */
  path: string;
  /** Hash of the content the edits were verified against. The write is refused if the disk differs. */
  before: string;
  /** Content after all edits, in the file's original line-ending style. */
  after: string;
  /** Original text, kept for undo and for rollback. */
  original: string;
}

export interface ApplyResult {
  undoId: string;
  files: Array<{ path: string; before: string; after: string }>;
}

export interface UndoResult {
  undoId: string;
  restored: string[];
}
