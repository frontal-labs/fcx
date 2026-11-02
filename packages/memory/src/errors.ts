export type MemoryErrorCode =
  | "invalid_record"
  | "secret_detected"
  | "schema_mismatch"
  | "invalid_budget"
  | "invalid_path";

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}
