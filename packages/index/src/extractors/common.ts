import { execFile } from "node:child_process";
import { buildChunk } from "../chunk.js";
import type { ExtractionResult } from "../extract.js";
import type { SymbolInput, SymbolKind } from "../types.js";

/** Result of extracting one file. `warning` is set when the file could not be parsed. */
export interface FileExtraction {
  readonly result: ExtractionResult;
  readonly warning?: string;
  /** Set when the language's toolchain is missing. The indexer reports that once per run. */
  readonly missingTool?: string;
}

export const MAX_SIGNATURE_LENGTH = 200;
export const MAX_DOC_LENGTH = 400;

export const NO_SYMBOLS: ExtractionResult = { symbols: [], imports: [], calls: [] };

export function skipped(warning: string): FileExtraction {
  return { result: NO_SYMBOLS, warning };
}

/** Collapses whitespace runs and clips to `limit` characters. */
export function clip(text: string, limit: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? collapsed.slice(0, limit) : collapsed;
}

export interface SymbolDraft {
  readonly name: string;
  readonly qualified: string;
  readonly kind: SymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc: string;
  readonly exported: boolean;
}

/** Builds a stored symbol, including the chunk text, from a draft and the file's lines. */
export function makeSymbol(draft: SymbolDraft, lines: readonly string[]): SymbolInput {
  const signature = clip(draft.signature, MAX_SIGNATURE_LENGTH);
  const doc = draft.doc.trim().slice(0, MAX_DOC_LENGTH);
  const chunk = buildChunk({
    qualified: draft.qualified,
    signature,
    doc,
    lines,
    startLine: draft.startLine,
    endLine: draft.endLine,
  });
  return {
    name: draft.name,
    qualified: draft.qualified,
    kind: draft.kind,
    startLine: draft.startLine,
    endLine: draft.endLine,
    signature,
    doc,
    exported: draft.exported,
    chunkText: chunk.text,
    tokens: chunk.tokens,
  };
}

/** Runs a child process with argv only (no shell) and returns its outcome. */
export interface ProcessOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the binary could not be started, for example `ENOENT`. */
  readonly spawnCode?: string;
}

/**
 * Runs `file` with `args` (argv only, never a shell string) with a timeout and an output cap.
 * Never rejects: failures are reported in the returned outcome.
 */
export function runProcess(
  file: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBuffer: number; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
        env: options.env,
        cwd: options.cwd,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        resolve({
          ok: false,
          stdout: String(stdout),
          stderr: String(stderr) || error.message,
          spawnCode: typeof code === "string" ? code : undefined,
        });
      },
    );
  });
}
