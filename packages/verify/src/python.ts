import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { findExecutable, runArgv } from "./exec.js";
import {
  type Located,
  available,
  executionFailure,
  firstLine,
  toErrors,
  unavailable,
  verifyInScratch,
} from "./run.js";
import type { VerifyOptions, VerifyResult } from "./verify-types.js";

export const PYTHON_TIMEOUT_MS = 10_000;

/** `  File "...", line N` in a traceback. */
const PY_FILE_LINE = /^\s*File ".*", line (\d+)/;
/** The final `SyntaxError: message` line of a traceback. */
const PY_ERROR_LINE = /^(\w*(?:Error|Exception)): (.+)$/;
/** pyflakes: `path:line:col: message`. */
const PYFLAKES_LINE = /^(.+?):(\d+):\d+: (.+)$/;

/** Parses the traceback that `python3 -m py_compile` prints for a syntax error. */
export function parsePyCompileOutput(output: string): Located[] {
  const located: Located[] = [];
  let pendingLine: number | undefined;
  for (const raw of output.split("\n")) {
    const line = raw.trimEnd();
    const where = PY_FILE_LINE.exec(line);
    if (where !== null) {
      pendingLine = Number(where[1]);
      continue;
    }
    const error = PY_ERROR_LINE.exec(line);
    if (error !== null && pendingLine !== undefined) {
      located.push({ line: pendingLine, message: `${error[1]}: ${error[2]}` });
      pendingLine = undefined;
    }
  }
  return located;
}

/** Parses pyflakes output. Every line refers to the single file that was checked. */
export function parsePyflakesOutput(output: string): Located[] {
  const located: Located[] = [];
  for (const raw of output.split("\n")) {
    const match = PYFLAKES_LINE.exec(raw.trimEnd());
    if (match === null) continue;
    located.push({ line: Number(match[2]), message: match[3] ?? "" });
  }
  return located;
}

/**
 * Checks a Python file: `py_compile` for syntax, then pyflakes when it is importable.
 * Only the candidate is copied, so no sibling module can shadow the stdlib during the check.
 * pyflakes is never installed; without it the result is a syntax-only check, and `reason` says so.
 */
export function verifyPython(options: VerifyOptions): Promise<VerifyResult> {
  return verifyInScratch("python", options, PYTHON_TIMEOUT_MS, async (scratch, timeoutMs) => {
    const python = findExecutable("python3");
    if (python === undefined) return unavailable("python", "python3 not found on PATH");

    // The candidate lives in its own subdirectory and every run uses an empty cwd. Isolated mode (-I)
    // keeps both the script directory and the cwd off sys.path, so a repo file named like a module
    // (json.py, pyflakes.py) is never imported.
    const checkDir = join(scratch, "check");
    const cwd = join(scratch, "cwd");
    await mkdir(checkDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const target = join(checkDir, basename(options.file));
    await writeFile(target, options.candidateText, "utf-8");

    const compile = await runArgv([python, "-I", "-m", "py_compile", target], { cwd, timeoutMs });
    const compileFailure = executionFailure("python", "py_compile", compile, timeoutMs);
    if (compileFailure !== undefined) return compileFailure;

    const syntax = parsePyCompileOutput(`${compile.stderr}\n${compile.stdout}`);
    if (compile.exitCode !== 0) {
      if (syntax.length === 0) {
        return unavailable(
          "python",
          `py_compile failed without parseable diagnostics: ${firstLine(compile)}`,
        );
      }
      return available("python", toErrors(syntax, basename(options.file), options.originalErrors));
    }

    const probe = await runArgv([python, "-I", "-c", "import pyflakes"], { cwd, timeoutMs });
    if (probe.exitCode !== 0 || probe.timedOut || probe.spawnError !== undefined) {
      return available("python", [], "pyflakes is not importable; syntax check only");
    }

    const flakes = await runArgv([python, "-I", "-m", "pyflakes", target], { cwd, timeoutMs });
    const flakesFailure = executionFailure("python", "pyflakes", flakes, timeoutMs);
    if (flakesFailure !== undefined) return flakesFailure;

    const reported = parsePyflakesOutput(`${flakes.stdout}\n${flakes.stderr}`);
    if (flakes.exitCode !== 0 && reported.length === 0) {
      return unavailable(
        "python",
        `pyflakes failed without parseable diagnostics: ${firstLine(flakes)}`,
      );
    }
    return available("python", toErrors(reported, basename(options.file), options.originalErrors));
  });
}
