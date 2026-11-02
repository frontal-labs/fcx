import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
} from "vscode-jsonrpc/node";
import type { ServerCommand } from "./types.js";

const STDERR_TAIL_CHARS = 4000;

/** A spawned language server process wired to a JSON-RPC connection over its stdio. */
export interface ServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: MessageConnection;
  /** The most recent stderr output, capped. */
  stderrTail(): string;
}

/**
 * Start a server process with its working directory set to the workspace.
 * Throws synchronously only for invalid input. Spawn failures (for example a missing
 * binary) surface as an `error` event on the child, which the caller observes via `child`.
 */
export function spawnServer(command: ServerCommand, cwd: string): ServerProcess {
  const child = spawn(command.command, [...command.args], {
    cwd,
    env: { ...process.env, ...command.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL_CHARS);
  });
  // Without a listener the server's stdout would stall once the OS pipe fills up.
  child.stdout.on("error", () => undefined);
  child.stdin.on("error", () => undefined);

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  return {
    child,
    connection,
    stderrTail: () => tail.trim(),
  };
}
