import { AcpConfigError } from "./errors.js";
import type { AcpHandler, TaskStopReason } from "./types.js";

/** Throws `AcpConfigError` unless `handler` is an object with a `runTask` function. */
export function assertHandler(handler: unknown): asserts handler is AcpHandler {
  if (typeof handler !== "object" || handler === null || !("runTask" in handler)) {
    throw new AcpConfigError("createAcpAgent requires a handler with a runTask method");
  }
  if (typeof handler.runTask !== "function") {
    throw new AcpConfigError("createAcpAgent handler.runTask must be a function");
  }
}

/** Narrows an untrusted stop reason from a handler to a known value. */
export function isTaskStopReason(value: unknown): value is TaskStopReason {
  return value === "end_turn" || value === "cancelled" || value === "error";
}

/** Renders a thrown value as a message for the summary chunk. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
