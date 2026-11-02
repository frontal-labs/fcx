/** Stop reasons a handler may report. Mapped onto ACP `PromptResponse.stopReason`. */
export type TaskStopReason = "end_turn" | "cancelled" | "error";

/** A task forwarded to the handler for one `session/prompt` turn. */
export interface TaskRequest {
  readonly sessionId: string;
  readonly cwd: string;
  readonly text: string;
}

/** One progress update emitted by the handler while a task runs. */
export interface ProgressUpdate {
  readonly kind: string;
  readonly message: string;
}

/** Callback the handler uses to stream progress. Updates are sent in call order. */
export type ProgressReporter = (update: ProgressUpdate) => void;

/** The handler's final result for one task. */
export interface TaskResult {
  readonly stopReason: TaskStopReason;
  readonly summary: string;
}

/**
 * The CLI-side handler that does the actual work. The agent never edits files
 * itself: every task is forwarded here, and any edits happen inside the handler.
 * `signal` aborts when the client cancels the prompt.
 */
export interface AcpHandler {
  runTask(task: TaskRequest, progress: ProgressReporter, signal: AbortSignal): Promise<TaskResult>;
}

/** Options for `createAcpAgent`. */
export interface AcpAgentOptions {
  readonly handler: AcpHandler;
  /** Name reported in the SDK's diagnostics. Defaults to "fcx-acp". */
  readonly name?: string;
}

/** Byte streams for stdio-style transports (NDJSON framed). */
export interface StdioStreams {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
}
