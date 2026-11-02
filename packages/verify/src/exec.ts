import { spawn } from "node:child_process";
import { constants, accessSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export const DEFAULT_MAX_BYTES = 256 * 1024;

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  /** Variables added to (or overriding) the inherited environment. */
  env?: Readonly<Record<string, string>>;
  /** Per-stream cap. Output beyond it is dropped and `truncated` is set. */
  maxBytes?: number;
}

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Set when the process could not be started at all. */
  spawnError?: string;
}

/**
 * Runs a program from an argv array (no shell). The child is killed when it exceeds `timeoutMs`.
 * Never rejects: failures are reported in the result.
 */
export function runArgv(argv: readonly string[], options: ExecOptions): Promise<ExecResult> {
  const [program, ...args] = argv;
  if (program === undefined) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      truncated: false,
      spawnError: "empty argv",
    });
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const env = { ...process.env, ...options.env };

  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(program, args, { cwd: options.cwd, env, shell: false, stdio: "pipe" });

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const collect = (current: string, chunk: Buffer): string => {
      const room = maxBytes - Buffer.byteLength(current);
      if (room <= 0) {
        truncated = true;
        return current;
      }
      if (chunk.length > room) {
        truncated = true;
        return current + chunk.subarray(0, room).toString("utf-8");
      }
      return current + chunk.toString("utf-8");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({
        exitCode: null,
        timedOut,
        stdout,
        stderr,
        truncated,
        spawnError: error.message,
      });
    });
    child.on("close", (code) => {
      finish({ exitCode: code, timedOut, stdout, stderr, truncated });
    });
  });
}

/**
 * Finds an executable on PATH without a shell. Same result as `command -v <name>` for a bare name.
 * Returns an absolute path, or undefined when nothing executable is found.
 */
export function findExecutable(
  name: string,
  pathEnv: string | undefined = process.env.PATH,
): string | undefined {
  if (isAbsolute(name)) return isExecutable(name) ? name : undefined;
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
