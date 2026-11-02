import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { type Server, type Socket, connect, createServer } from "node:net";
import { dirname, isAbsolute } from "node:path";
import { format } from "node:util";
import { FcError, resolveConfig } from "@fcx/config";
import { type GlobalArgs, parseGlobalArgs } from "../args.js";
import {
  STOP_ARG,
  WARM_CONNECT_MS,
  type WarmRequest,
  type WarmResponse,
  asWarmServerRequest,
  readWarmSettings,
  sendWarmRequest,
  socketPathFor,
} from "./client.js";

/** A request line larger than this is dropped, so a client cannot exhaust server memory. */
const MAX_REQUEST_BYTES = 1024 * 1024;
/** How long a connection may take to send its request line. */
const REQUEST_READ_MS = 5000;
const ALREADY_RUNNING = "a warm fcx server is already running for this cache directory";

export interface ServeOptions {
  socketPath: string;
  /** Exit after this long without a request. Injectable so tests can use milliseconds. */
  idleMs: number;
  log?: (line: string) => void;
}

export interface ServeHandle {
  readonly socketPath: string;
  /** Resolves once the server has stopped and its socket file is removed. */
  readonly closed: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Starts the warm server on a unix socket. The socket is 0600 and its directory 0700. A stale socket
 * left by a dead process is replaced. A socket that still answers means a server is already running.
 */
export async function startServer(options: ServeOptions): Promise<ServeHandle> {
  const { socketPath, idleMs, log } = options;
  const runDir = dirname(socketPath);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(runDir, 0o700);
  await clearStaleSocket(socketPath);

  let busy = 0;
  let stopping = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const sockets = new Set<Socket>();
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const server: Server = createServer(onConnection);

  // Nothing else runs while listen binds the socket, so the umask only needs to hold for that call.
  const previousMask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(
      isCode(error, "EADDRINUSE")
        ? ALREADY_RUNNING
        : `cannot listen on ${socketPath}: ${message(error)}`,
    );
  } finally {
    process.umask(previousMask);
  }
  // Registered only after a successful bind, so a failed listen never tears down someone else's socket.
  server.on("error", () => void shutdown("server error"));
  await chmod(socketPath, 0o600);
  touch();

  let queue: Promise<void> = Promise.resolve();

  function onConnection(socket: Socket): void {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(REQUEST_READ_MS, () => socket.destroy());

    let buffer = "";
    let handled = false;
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      handled = true;
      socket.setTimeout(0);
      const line = buffer.slice(0, newline);
      queue = queue.then(() => serveOne(socket, line)).catch(() => undefined);
    });
  }

  async function serveOne(socket: Socket, line: string): Promise<void> {
    if (stopping) {
      socket.destroy();
      return;
    }
    busy++;
    try {
      const { response, stop } = await handleRequestLine(line, log);
      const payload = `${JSON.stringify(response)}\n`;
      if (stop) {
        socket.end(payload, () => void shutdown("stop request"));
      } else {
        socket.end(payload);
      }
    } finally {
      busy--;
      touch();
    }
  }

  /** Restarts the idle clock. The timer only exits the server when no request is running. */
  function touch(): void {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (busy === 0) void shutdown("idle");
    }, idleMs);
  }

  async function shutdown(reason: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
    log?.(`fcx serve: stopped (${reason})`);
    markClosed();
  }

  return { socketPath, closed, stop: () => shutdown("requested") };
}

/** Sends `__stop__` to a running server. Resolves `false` when no server answers. */
export async function stopRunningServer(socketPath: string, cwd: string): Promise<boolean> {
  const outcome = await sendWarmRequest(socketPath, {
    id: randomUUID(),
    argv: [STOP_ARG],
    cwd,
  });
  return outcome.kind === "response" && outcome.response.exitCode === 0;
}

/**
 * Answers one request line. Returns `stop: true` for the stop request so the caller can exit after
 * replying. Every other request is checked first, then run through the same `run` the CLI uses.
 */
export async function handleRequestLine(
  line: string,
  log?: (line: string) => void,
): Promise<{ response: WarmResponse; stop: boolean }> {
  const parsed = parseRequestLine(line);
  if (!parsed.ok)
    return { response: reply(parsed.id, `invalid request: ${parsed.message}`), stop: false };
  const request = parsed.request;
  if (request.argv.length === 1 && request.argv[0] === STOP_ARG) {
    return { response: reply(request.id, "", 0), stop: true };
  }

  const prepared = prepare(request);
  if (!prepared.ok)
    return { response: reply(request.id, `refused: ${prepared.message}`), stop: false };

  log?.(`fcx serve: ${request.argv.join(" ")} (${request.cwd})`);
  const result = await runCaptured(prepared.args);
  return { response: { id: request.id, ...result }, stop: false };
}

function reply(id: string | null, stderrMessage: string, exitCode = 1): WarmResponse {
  return {
    id,
    exitCode,
    stdout: "",
    stderr: stderrMessage === "" ? "" : `fcx serve: ${stderrMessage}\n`,
  };
}

type Parsed =
  | { ok: true; request: WarmRequest }
  | { ok: false; id: string | null; message: string };

function parseRequestLine(line: string): Parsed {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, id: null, message: "not JSON" };
  }
  if (!isRecord(value)) return { ok: false, id: null, message: "not an object" };
  const id = typeof value.id === "string" ? value.id : null;
  if (id === null) return { ok: false, id: null, message: "id must be a string" };
  if (typeof value.cwd !== "string") return { ok: false, id, message: "cwd must be a string" };
  if (!Array.isArray(value.argv)) return { ok: false, id, message: "argv must be an array" };
  const argv: string[] = [];
  for (const item of value.argv) {
    if (typeof item !== "string") return { ok: false, id, message: "argv must contain strings" };
    argv.push(item);
  }
  return { ok: true, request: { id, argv, cwd: value.cwd } };
}

type Prepared = { ok: true; args: GlobalArgs } | { ok: false; message: string };

/**
 * Checks a request before anything runs. The client's argv is not trusted: `serve` is refused, and so is
 * any `-C` that is not an existing absolute directory. The effective cwd is the one the client sent.
 */
function prepare(request: WarmRequest): Prepared {
  if (!isAbsolute(request.cwd) || !isDirectory(request.cwd)) {
    return { ok: false, message: "cwd must be an existing absolute directory" };
  }
  if (request.argv.includes(STOP_ARG)) {
    return { ok: false, message: `${STOP_ARG} is only accepted alone` };
  }
  let args: GlobalArgs;
  try {
    args = parseGlobalArgs(request.argv);
  } catch (error) {
    return { ok: false, message: message(error) };
  }
  if (args.command === "serve") {
    return { ok: false, message: "serve cannot run through the warm server" };
  }
  if (args.command === "acp") {
    return { ok: false, message: "acp cannot run through the warm server" };
  }
  if (args.cwd !== undefined && (!isAbsolute(args.cwd) || !isDirectory(args.cwd))) {
    return { ok: false, message: "-C must be an existing absolute directory" };
  }
  // A warm server has no terminal to answer prompts. Hosted escalation is disabled here, matching a run
  // with no terminal, so nothing can reach the network or write without an answer from the caller.
  return { ok: true, args: { ...args, cwd: args.cwd ?? request.cwd, noEscalate: true } };
}

/**
 * Runs the command with console output captured. The ACP handler uses it too, so a prompt runs the same way a
 * warm request does: no prompt can be answered and no routing happens. Output is identical to the in-process run because the
 * same functions write it. Requests are serialized by the caller, so the console swap cannot interleave.
 */
export async function runCaptured(
  args: GlobalArgs,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const saved = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const toOut = (...parts: unknown[]): void => {
    out.push(`${format(...parts)}\n`);
  };
  const toErr = (...parts: unknown[]): void => {
    err.push(`${format(...parts)}\n`);
  };
  console.log = toOut;
  console.info = toOut;
  console.debug = toOut;
  console.warn = toErr;
  console.error = toErr;
  try {
    const { run } = await import("../app.js");
    const exitCode = await asWarmServerRequest(() => run(args));
    return { exitCode, stdout: out.join(""), stderr: err.join("") };
  } catch (error) {
    err.push(errorText(error));
    return { exitCode: 1, stdout: out.join(""), stderr: err.join("") };
  } finally {
    console.log = saved.log;
    console.info = saved.info;
    console.debug = saved.debug;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

/** Same error text `main` prints for an in-process failure. */
function errorText(error: unknown): string {
  if (error instanceof FcError) {
    const hint = error.hint ? `\n${error.hint}` : "";
    return `${error.code}: ${error.message}${hint}\n`;
  }
  return `${message(error)}\n`;
}

async function clearStaleSocket(socketPath: string): Promise<void> {
  const stat = await lstat(socketPath).catch(() => undefined);
  if (stat === undefined) return;
  if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  if (await probeSocket(socketPath, WARM_CONNECT_MS)) throw new Error(ALREADY_RUNNING);
  await unlink(socketPath);
}

/** True when something accepts a connection on the socket within `timeoutMs`. */
function probeSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const done = (alive: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `fcx serve`: runs the warm server in the foreground, or stops one with `--stop`. */
export async function runServe(args: GlobalArgs, cwd: string): Promise<number> {
  const resolved = resolveConfig(cwd, { permissionMode: args.permissionMode });
  const socketPath = socketPathFor(resolved.paths.cacheDir);

  if (args.rest.length === 1 && args.rest[0] === "--stop") {
    if (await stopRunningServer(socketPath, cwd)) {
      console.log("fcx serve: stopped");
    } else {
      console.log("fcx serve: no warm server is running");
    }
    return 0;
  }
  if (args.rest.length > 0) {
    console.error("usage: fcx serve [--stop]");
    return 1;
  }

  const idleMinutes = readWarmSettings(resolved.settings).idleExitMinutes;
  let handle: ServeHandle;
  try {
    handle = await startServer({
      socketPath,
      idleMs: idleMinutes * 60_000,
      log: (line) => console.error(line),
    });
  } catch (error) {
    console.error(message(error));
    return 1;
  }
  console.log(`fcx serve: listening on ${socketPath} (idle exit after ${idleMinutes} min)`);

  const onSignal = (): void => {
    void handle.stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await handle.closed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}
