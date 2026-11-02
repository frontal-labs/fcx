import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { findExecutable, runArgv } from "./exec.js";
import {
  type Located,
  available,
  copyIfPresent,
  executionFailure,
  findUp,
  firstLine,
  normalizeReported,
  toErrors,
  toPosixRelative,
  unavailable,
  verifyInScratch,
} from "./run.js";
import type { VerifyOptions, VerifyResult } from "./verify-types.js";

export const GO_TIMEOUT_MS = 60_000;

/** `file.go:line:col: message`, optionally prefixed by `vet: ` or `./`. */
const GO_DIAGNOSTIC = /^(?:vet: )?(\.\/)?([^\s:]+\.go):(\d+):\d+: (.+)$/;

/** Parses `go vet` output. Header lines such as `# example.com/m` are ignored. */
export function parseGoVetOutput(output: string): Located[] {
  const located: Located[] = [];
  for (const line of output.split("\n")) {
    const match = GO_DIAGNOSTIC.exec(line.trimEnd());
    if (match === null) continue;
    located.push({
      path: normalizeReported(match[2] ?? ""),
      line: Number(match[3]),
      message: match[4] ?? "",
    });
  }
  return located;
}

/**
 * Checks a Go file with `go vet ./...` in a scratch copy of its module.
 * Copies go.mod, go.sum and the package directory only, so imports of other packages in the module
 * are not resolved. Such imports show up as errors.
 */
export function verifyGo(options: VerifyOptions): Promise<VerifyResult> {
  return verifyInScratch("go", options, GO_TIMEOUT_MS, async (scratch, timeoutMs) => {
    const goBin = findExecutable("go");
    if (goBin === undefined) return unavailable("go", "go not found on PATH");

    const fileDir = dirname(options.file);
    const moduleRoot = findUp(fileDir, options.workspace, "go.mod");
    if (moduleRoot === undefined)
      return unavailable("go", "no go.mod between the file and the workspace root");

    const candidateKey = toPosixRelative(moduleRoot, options.file);
    await copyIfPresent(join(moduleRoot, "go.mod"), join(scratch, "go.mod"));
    await copyIfPresent(join(moduleRoot, "go.sum"), join(scratch, "go.sum"));

    const packageDir = join(scratch, toPosixRelative(moduleRoot, fileDir));
    await mkdir(packageDir, { recursive: true });
    for (const entry of await readdir(fileDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".go")) {
        await copyIfPresent(join(fileDir, entry.name), join(packageDir, entry.name));
      }
    }
    await writeFile(join(scratch, candidateKey), options.candidateText, "utf-8");

    const result = await runArgv([goBin, "vet", "./..."], {
      cwd: scratch,
      timeoutMs,
      env: { GOFLAGS: "-mod=readonly", GOPROXY: "off" },
    });
    const failure = executionFailure("go", "go vet", result, timeoutMs);
    if (failure !== undefined) return failure;

    const located = parseGoVetOutput(`${result.stderr}\n${result.stdout}`);
    if (result.exitCode !== 0 && located.length === 0) {
      return unavailable("go", `go vet failed without parseable diagnostics: ${firstLine(result)}`);
    }
    return available("go", toErrors(located, candidateKey, options.originalErrors));
  });
}
