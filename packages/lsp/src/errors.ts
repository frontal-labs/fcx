/**
 * Stable error codes. Callers match on `code`, not on the message.
 *
 * - TIMEOUT: a request or an overlay check did not answer in time.
 * - CRASHED: the server process exited unexpectedly and no restart is left.
 * - PROTOCOL_ERROR: the server answered with a JSON-RPC error or an unexpected payload.
 * - START_FAILED: the server could not be started or initialized.
 * - POOL_CLOSED: the pool was shut down before or during the call.
 * - INVALID_ARGUMENT: the caller passed input this package cannot use.
 */
export type LspErrorCode =
  | "TIMEOUT"
  | "CRASHED"
  | "PROTOCOL_ERROR"
  | "START_FAILED"
  | "POOL_CLOSED"
  | "INVALID_ARGUMENT";

export interface LspErrorOptions {
  readonly language?: string;
  readonly cause?: unknown;
}

export class LspError extends Error {
  readonly code: LspErrorCode;
  readonly language: string | undefined;

  constructor(code: LspErrorCode, message: string, options: LspErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LspError";
    this.code = code;
    this.language = options.language;
  }
}

export function isLspError(value: unknown): value is LspError {
  return value instanceof LspError;
}
