import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";
import { MemoryError } from "./errors";

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE memory(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('accepted_fix', 'rejected', 'convention')),
  text TEXT NOT NULL,
  file_path TEXT,
  symbol TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  content_hash TEXT
);
CREATE UNIQUE INDEX memory_content_hash ON memory(content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX memory_file_path ON memory(file_path);
CREATE INDEX memory_symbol ON memory(symbol);
`;

let sqliteModule: typeof Sqlite | undefined;

function isSqliteExperimentalWarning(args: readonly unknown[]): boolean {
  const [warning, type] = args;
  const name = warning instanceof Error ? warning.name : type;
  const message = warning instanceof Error ? warning.message : String(warning);
  return name === "ExperimentalWarning" && /sqlite/i.test(message);
}

/**
 * Loads node:sqlite once. Node prints an ExperimentalWarning on first load; only that
 * warning is suppressed, and process.emitWarning is restored right after the load.
 */
export function loadSqlite(): typeof Sqlite {
  if (sqliteModule) {
    return sqliteModule;
  }
  const require = createRequire(import.meta.url);
  const original = process.emitWarning;
  const silenced = function silencedSqliteWarning(...args: Parameters<typeof original>): void {
    if (isSqliteExperimentalWarning(args)) {
      return;
    }
    original.apply(process, args);
  };
  process.emitWarning = silenced as typeof original;
  try {
    sqliteModule = require("node:sqlite") as typeof Sqlite;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

function tableNames(db: Sqlite.DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const names = new Set<string>();
  for (const row of rows) {
    const name = row.name;
    if (typeof name === "string") {
      names.add(name);
    }
  }
  return names;
}

/**
 * Creates the schema in an empty database, or checks that an existing database has the
 * expected schema version. A database with a different (or unknown) version is refused.
 */
export function ensureSchema(db: Sqlite.DatabaseSync): void {
  const tables = tableNames(db);
  if (!tables.has("memory") && !tables.has("meta")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA_SQL);
      db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return;
  }

  const found = tables.has("meta")
    ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    : undefined;
  const version = found?.value;
  if (version !== String(SCHEMA_VERSION)) {
    const shown = typeof version === "string" ? version : "unknown";
    throw new MemoryError(
      "schema_mismatch",
      `memory database schema version is ${shown}, expected ${SCHEMA_VERSION}`,
    );
  }
}
