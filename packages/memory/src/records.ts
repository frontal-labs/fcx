import type * as Sqlite from "node:sqlite";
import { MemoryError } from "./errors";
import { detectSecret } from "./redact";
import { MEMORY_KINDS, type MemoryKind, type MemoryRecord, type NewMemoryRecord } from "./types";

export const MAX_TEXT_LENGTH = 1000;
export const MAX_FIELD_LENGTH = 512;

export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}

function checkField(label: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new MemoryError("invalid_record", `${label} is longer than ${maxLength} characters`);
  }
  const secret = detectSecret(value);
  if (secret !== null) {
    throw new MemoryError("secret_detected", `refusing to store ${label}: it matches a ${secret}`);
  }
}

/** Validates a record and returns it with trimmed fields. Throws MemoryError otherwise. */
export function normalizeRecord(input: NewMemoryRecord): NewMemoryRecord {
  if (!isMemoryKind(input.kind)) {
    throw new MemoryError("invalid_record", `unknown memory kind: ${String(input.kind)}`);
  }
  const text = input.text.trim();
  if (text.length === 0) {
    throw new MemoryError("invalid_record", "memory text must not be empty");
  }
  checkField("memory text", text, MAX_TEXT_LENGTH);
  const source = input.source.trim();
  if (source.length === 0) {
    throw new MemoryError("invalid_record", "memory source must not be empty");
  }
  checkField("memory source", source, MAX_FIELD_LENGTH);
  const normalized: NewMemoryRecord = { kind: input.kind, text, source };
  if (input.filePath !== undefined) {
    const filePath = input.filePath.trim();
    checkField("file path", filePath, MAX_FIELD_LENGTH);
    normalized.filePath = filePath;
  }
  if (input.symbol !== undefined) {
    const symbol = input.symbol.trim();
    checkField("symbol", symbol, MAX_FIELD_LENGTH);
    normalized.symbol = symbol;
  }
  return normalized;
}

function text(row: Record<string, Sqlite.SQLOutputValue>, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new MemoryError("schema_mismatch", `column ${column} is not text`);
  }
  return value;
}

function textOrNull(row: Record<string, Sqlite.SQLOutputValue>, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  return text(row, column);
}

export function rowToRecord(row: Record<string, Sqlite.SQLOutputValue>): MemoryRecord {
  const kind = text(row, "kind");
  if (!isMemoryKind(kind)) {
    throw new MemoryError("schema_mismatch", `unknown memory kind in database: ${kind}`);
  }
  const id = row.id;
  const createdAt = row.created_at;
  if (typeof id !== "number" || typeof createdAt !== "number") {
    throw new MemoryError("schema_mismatch", "memory id and created_at must be numbers");
  }
  return {
    id,
    kind,
    text: text(row, "text"),
    filePath: textOrNull(row, "file_path"),
    symbol: textOrNull(row, "symbol"),
    source: text(row, "source"),
    createdAt,
  };
}

/** Inserts a validated record and returns its id. */
export function insertRecord(
  db: Sqlite.DatabaseSync,
  record: NewMemoryRecord,
  contentHash: string | null,
  createdAt: number,
): number {
  const result = db
    .prepare(
      "INSERT INTO memory(kind, text, file_path, symbol, source, created_at, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      record.kind,
      record.text,
      record.filePath ?? null,
      record.symbol ?? null,
      record.source,
      createdAt,
      contentHash,
    );
  return Number(result.lastInsertRowid);
}
