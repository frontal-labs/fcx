import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import type { MergedSettings } from "@fcx/config";
import type { GlobalArgs } from "../args.js";
import { resolveFcxConfig } from "./config.js";

/** Env switch that turns the warm server on for one run (plan §15.2 item 3). */
export const WARM_ENV = "FCX_WARM";
/** Env switch that forces in-process runs, bypassing the warm server entirely. */
export const NO_WARM_ENV = "FCX_NO_WARM";
/** Argv a client sends to ask the warm server to exit. Never a valid command. */
export const STOP_ARG = "__stop__";
/** How long a client waits for the socket to accept a connection before running in-process. */
export const WARM_CONNECT_MS = 200;
const DEFAULT_IDLE_EXIT_MINUTES = 15;

/** A request as sent over the socket: one JSON object per connection, terminated by a newline. */
export interface WarmRequest {
  id: string;
  argv: string[];
  cwd: string;
}

/** The server's answer. `exitCode` is what the command would have returned in-process. */
export interface WarmResponse {
  id: string | null;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface WarmSettings {
  enabled: boolean;
  idleExitMinutes: number;
}

/** Socket path for a cache directory: `<cache>/run/fc.sock` (plan §5.5, §11.3). */
export function socketPathFor(cacheDir: string): string {
  return join(cacheDir, "run", "fc.sock");
}

/** Reads `fc.warmServer` and `fc.idleExitMinutes` from merged settings. Invalid values use the defaults. */
export function readWarmSettings(settings: MergedSettings): WarmSettings {
  const fc = isRecord(settings.fc) ? settings.fc : {};
  const minutes = fc.idleExitMinutes;
  const idleExitMinutes =
    typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0
      ? minutes
      : DEFAULT_IDLE_EXIT_MINUTES;
  return { enabled: fc.warmServer === true, idleExitMinutes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds the argv a user would type after the binary from parsed args. Global flags are emitted before the
 * command, and the server parses them back to the same values.
 */
export function argvFromArgs(args: GlobalArgs): string[] {
  const argv = ["--output-format", args.outputFormat];
  if (args.permissionMode !== undefined) argv.push("--permission-mode", args.permissionMode);
  if (args.cwd !== undefined) argv.push("-C", args.cwd);
  if (args.dryRun) argv.push("--dry-run");
  if (args.noEscalate) argv.push("--no-escalate");
  if (args.command !== undefined) argv.push(args.command, ...args.rest);
  return argv;
}

/**
 * What happened to one request. `unavailable`: nothing was sent, so running in-process is safe.
 * `lost`: the request was written, and the connection ended without a usable answer. The server may
 * already have run it, so the client must report that and must never retry.
 */
export type WarmOutcome =
  | { readonly kind: "response"; readonly response: WarmResponse }
  | { readonly kind: "unavailable" }
  | { readonly kind: "lost" };

/** Sends one request to a warm server. See `WarmOutcome` for what each result allows the caller to do. */
export function sendWarmRequest(
  socketPath: string,
  request: WarmRequest,
  connectMs: number = WARM_CONNECT_MS,
): Promise<WarmOutcome> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    let settled = false;
    let sent = false;
    let received = "";
    const finish = (outcome: WarmOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const finishAfterClose = (): void => {
      const response = parseResponse(received);
      if (response !== undefined) finish({ kind: "response", response });
      else finish(sent ? { kind: "lost" } : { kind: "unavailable" });
    };
    const timer = setTimeout(() => finish({ kind: "unavailable" }), connectMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      sent = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
    });
    socket.on("end", finishAfterClose);
    socket.on("close", finishAfterClose);
    socket.on("error", () => finish(sent ? { kind: "lost" } : { kind: "unavailable" }));
  });
}

/** Parses the single response line. Anything that is not a well-formed response counts as no answer. */
export function parseResponse(text: string): WarmResponse | undefined {
  const line = text.split("\n")[0];
  if (line === undefined || line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const { id, exitCode, stdout, stderr } = value;
  if (typeof exitCode !== "number" || typeof stdout !== "string" || typeof stderr !== "string") {
    return undefined;
  }
  return {
    id: typeof id === "string" ? id : null,
    exitCode,
    stdout,
    stderr,
  };
}

let serving = false;

/** True while a warm server is executing a request. Prompts and hosted escalation are off in that state. */
export function isWarmServerRequest(): boolean {
  return serving;
}

/** Runs a server-side command with the serving flag set, so nested routing and prompts are disabled. */
export async function asWarmServerRequest<T>(fn: () => Promise<T>): Promise<T> {
  serving = true;
  try {
    return await fn();
  } finally {
    serving = false;
  }
}

/**
 * The routing hook used by `run`. When warm mode is on and a server answers, sends the command there and
 * returns its exit code after printing its output. Returns `undefined` to mean "run in-process". It never
 * throws: a failed warm path must not fail the command.
 */
export async function routeToWarmServer(args: GlobalArgs): Promise<number | undefined> {
  // `acp` owns stdin and stdout as the protocol stream, so it never goes to a warm server.
  if (serving || args.command === undefined || args.command === "serve") return undefined;
  if (args.command === "acp") return undefined;
  if (args.cwd !== undefined && !isAbsolute(args.cwd)) return undefined;
  // A warm server has no terminal to ask. Interactive fix must run here so the user can approve edits.
  if (args.command === "fix" && process.stdin.isTTY === true) return undefined;

  try {
    const cwd = args.cwd ?? process.cwd();
    if (process.env[NO_WARM_ENV] === "1") return undefined;
    const envOn = process.env[WARM_ENV] === "1";
    const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
    if (!envOn && !readWarmSettings(resolved.settings).enabled) return undefined;

    const outcome = await sendWarmRequest(socketPathFor(resolved.paths.cacheDir), {
      id: randomUUID(),
      argv: argvFromArgs(args),
      cwd,
    });
    if (outcome.kind === "unavailable") return undefined;
    if (outcome.kind === "lost") {
      // The request was already sent. Retrying could apply a change twice, so report and stop.
      process.stderr.write(
        "fcx: the warm server dropped the connection after the request was sent. The command may or may not have run. Nothing was retried; check the workspace before running it again.\n",
      );
      return 1;
    }
    process.stdout.write(outcome.response.stdout);
    process.stderr.write(outcome.response.stderr);
    return outcome.response.exitCode;
  } catch {
    return undefined;
  }
}
