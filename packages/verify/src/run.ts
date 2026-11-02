import { statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { ExecResult } from "./exec.js";
import { isWithin } from "./paths.js";
import type { Language, VerifyError, VerifyOptions, VerifyResult } from "./verify-types.js";

/** A diagnostic from a tool. `path` is undefined when the tool only reported the candidate. */
export interface Located {
  path?: string;
  line: number;
  message: string;
}

export function available(
  language: Language,
  errors: VerifyError[],
  reason?: string,
): VerifyResult {
  return reason === undefined
    ? { language, available: true, errors }
    : { language, available: true, errors, reason };
}

export function unavailable(language: Language, reason: string): VerifyResult {
  return { language, available: false, errors: [], reason };
}

/** Converts tool diagnostics to errors for the candidate, dropping messages that were already in `original`. */
export function toErrors(
  located: readonly Located[],
  candidateKey: string,
  original?: readonly VerifyError[],
): VerifyError[] {
  const errors = located.map((item): VerifyError => {
    const key = item.path === undefined ? candidateKey : normalizeReported(item.path);
    // Errors in other files keep their path, so breakage elsewhere is still reported.
    return {
      line: item.line,
      message: key === candidateKey ? item.message : `${key}: ${item.message}`,
    };
  });
  return filterOriginal(errors, original);
}

/** Removes errors whose message matches an original error. Each original matches at most one error. */
export function filterOriginal(
  errors: readonly VerifyError[],
  original?: readonly VerifyError[],
): VerifyError[] {
  if (original === undefined || original.length === 0) return [...errors];
  const remaining = new Map<string, number>();
  for (const item of original) remaining.set(item.message, (remaining.get(item.message) ?? 0) + 1);
  return errors.filter((item) => {
    const count = remaining.get(item.message) ?? 0;
    if (count > 0) {
      remaining.set(item.message, count - 1);
      return false;
    }
    return true;
  });
}

export function normalizeReported(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toPosixRelative(from: string, to: string): string {
  return normalizeReported(relative(from, to));
}

/** Runs `body` in a fresh directory that is removed afterwards, even when `body` throws. */
export async function withScratch<T>(
  tempRoot: string | undefined,
  body: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tempRoot ?? tmpdir(), "fcx-verify-"));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Common wrapper for the per-language verifiers. Rejects files outside the workspace, enforces the
 * scratch-directory lifecycle, and converts unexpected throws into an unavailable result.
 */
export async function verifyInScratch(
  language: Language,
  options: VerifyOptions,
  defaultTimeoutMs: number,
  body: (scratch: string, timeoutMs: number) => Promise<VerifyResult>,
): Promise<VerifyResult> {
  if (!isWithin(options.workspace, options.file)) {
    return unavailable(language, "file is outside the workspace");
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  try {
    return await withScratch(options.tempRoot, (dir) => body(dir, timeoutMs));
  } catch (error) {
    return unavailable(
      language,
      `verifier error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Returns an unavailable result when the tool timed out or could not start, otherwise undefined. */
export function executionFailure(
  language: Language,
  tool: string,
  result: ExecResult,
  timeoutMs: number,
): VerifyResult | undefined {
  if (result.timedOut) return unavailable(language, `TIMEOUT: ${tool} exceeded ${timeoutMs} ms`);
  if (result.spawnError !== undefined)
    return unavailable(language, `${tool} could not start: ${result.spawnError}`);
  return undefined;
}

/** First non-empty output line, used as the reason when a tool fails without parseable diagnostics. */
export function firstLine(result: ExecResult): string {
  const text = `${result.stderr}\n${result.stdout}`;
  return (
    text
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? "no output"
  );
}

/** Nearest directory at or above `startDir` that contains `name`, never above `boundary`. */
export function findUp(startDir: string, boundary: string, name: string): string | undefined {
  const stop = resolve(boundary);
  let dir = resolve(startDir);
  for (;;) {
    if (isFile(join(dir, name))) return dir;
    if (dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Copies a file from the real workspace into the scratch directory, if it exists. Read-only on the source. */
export async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (!isFile(source)) return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
