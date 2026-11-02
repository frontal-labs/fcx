export type IndexErrorCode =
  | "SQLITE_UNAVAILABLE"
  | "MALFORMED_DATABASE"
  | "SCHEMA_VERSION_MISMATCH";

/** Typed error for index database problems. Callers can switch on `code`. */
export class IndexError extends Error {
  readonly code: IndexErrorCode;
  readonly dbPath: string;

  constructor(
    code: IndexErrorCode,
    dbPath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IndexError";
    this.code = code;
    this.dbPath = dbPath;
  }
}
