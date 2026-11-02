import { Readable, Writable } from "node:stream";
import { type Stream, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AcpAgent } from "./agent.js";
import type { StdioStreams } from "./types.js";

/**
 * Connects `agent` to a message-level stream (for example an in-memory pair)
 * and resolves when the connection closes.
 */
export async function serveStreams(agent: AcpAgent, stream: Stream): Promise<void> {
  await agent.connect(stream).closed;
}

/** The process's stdin and stdout as NDJSON byte streams. */
export function processStdioStreams(): StdioStreams {
  return {
    input: Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    output: Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  };
}

/**
 * Serves `agent` over NDJSON byte streams. Defaults to the process's stdin and
 * stdout. stdout carries protocol frames only, so log to stderr. Resolves when
 * the connection closes.
 */
export async function serveStdio(
  agent: AcpAgent,
  streams: StdioStreams = processStdioStreams(),
): Promise<void> {
  await serveStreams(agent, ndJsonStream(streams.output, streams.input));
}
