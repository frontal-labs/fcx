import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { findExecutable, runArgv } from "./exec.js";
import { isWithin } from "./paths.js";
import {
  type Located,
  available,
  copyIfPresent,
  executionFailure,
  findUp,
  firstLine,
  isFile,
  normalizeReported,
  toErrors,
  toPosixRelative,
  unavailable,
  verifyInScratch,
} from "./run.js";
import type { VerifyOptions, VerifyResult } from "./verify-types.js";

export const RUST_TIMEOUT_MS = 120_000;

/** `file.rs:line:col: error[CODE]: message` from `cargo check --message-format=short`. */
const RUST_ERROR = /^(.+?):(\d+):\d+: error(?:\[[A-Z0-9]+\])?: (.+)$/;

/** Parses errors from `cargo check --message-format=short`. Warnings and `could not compile` lines are skipped. */
export function parseCargoShortOutput(output: string): Located[] {
  const located: Located[] = [];
  for (const raw of output.split("\n")) {
    const match = RUST_ERROR.exec(raw.trimEnd());
    if (match === null) continue;
    located.push({
      path: normalizeReported(match[1] ?? ""),
      line: Number(match[2]),
      message: match[3] ?? "",
    });
  }
  return located;
}

/**
 * Checks a Rust file with `cargo check` in a scratch copy of its crate (Cargo.toml, Cargo.lock, src/).
 * Only files under `src/` are covered, since `cargo check` without targets does not build tests or examples.
 * Offline mode is forced, and the target directory is inside the scratch directory.
 */
export function verifyRust(options: VerifyOptions): Promise<VerifyResult> {
  return verifyInScratch("rust", options, RUST_TIMEOUT_MS, async (scratch, timeoutMs) => {
    const cargo = findExecutable("cargo");
    if (cargo === undefined) return unavailable("rust", "cargo not found on PATH");

    const crateRoot = findUp(dirname(options.file), options.workspace, "Cargo.toml");
    if (crateRoot === undefined)
      return unavailable("rust", "no Cargo.toml between the file and the workspace root");
    const srcDir = join(crateRoot, "src");
    if (!isWithin(srcDir, options.file)) {
      return unavailable("rust", "cargo check covers only files under src/");
    }
    if (!isFile(join(crateRoot, "Cargo.toml"))) return unavailable("rust", "Cargo.toml is missing");

    const candidateKey = toPosixRelative(crateRoot, options.file);
    await copyIfPresent(join(crateRoot, "Cargo.toml"), join(scratch, "Cargo.toml"));
    await copyIfPresent(join(crateRoot, "Cargo.lock"), join(scratch, "Cargo.lock"));
    await mkdir(join(scratch, "src"), { recursive: true });
    await cp(srcDir, join(scratch, "src"), { recursive: true, dereference: false });
    await writeFile(join(scratch, candidateKey), options.candidateText, "utf-8");

    const result = await runArgv([cargo, "check", "--message-format=short"], {
      cwd: scratch,
      timeoutMs,
      env: { CARGO_TARGET_DIR: join(scratch, "target"), CARGO_NET_OFFLINE: "true" },
    });
    const failure = executionFailure("rust", "cargo check", result, timeoutMs);
    if (failure !== undefined) return failure;

    const located = parseCargoShortOutput(`${result.stderr}\n${result.stdout}`);
    if (result.exitCode !== 0 && located.length === 0) {
      return unavailable(
        "rust",
        `cargo check failed without parseable diagnostics: ${firstLine(result)}`,
      );
    }
    return available("rust", toErrors(located, candidateKey, options.originalErrors));
  });
}
