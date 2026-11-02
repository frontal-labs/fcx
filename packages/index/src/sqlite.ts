import { createRequire } from "node:module";
import type * as Sqlite from "node:sqlite";
import { IndexError } from "./errors.js";

export type { DatabaseSync, StatementSync } from "node:sqlite";

type SqliteModule = typeof Sqlite;

let cached: SqliteModule | undefined;

const SQLITE_WARNING = "SQLite is an experimental feature";

/**
 * Loads `node:sqlite`. On Node 22 it prints an ExperimentalWarning on first load. That warning
 * is suppressed for this one load only; every other warning passes through unchanged.
 */
export function loadSqlite(dbPath: string): SqliteModule {
  if (cached) {
    return cached;
  }
  const require = createRequire(import.meta.url);
  const emitWarning = process.emitWarning;
  process.emitWarning = function patchedEmitWarning(
    this: NodeJS.Process,
    warning: string | Error,
    ...rest: unknown[]
  ): void {
    const text = typeof warning === "string" ? warning : warning.message;
    const type = rest[0];
    const isSqliteWarning =
      text.includes(SQLITE_WARNING) &&
      (type === "ExperimentalWarning" ||
        (typeof warning !== "string" && warning.name === "ExperimentalWarning"));
    if (isSqliteWarning) {
      return;
    }
    Reflect.apply(emitWarning, this, [warning, ...rest]);
  } as typeof process.emitWarning;
  try {
    const mod: SqliteModule = require("node:sqlite");
    cached = mod;
    return mod;
  } catch (error) {
    throw new IndexError(
      "SQLITE_UNAVAILABLE",
      dbPath,
      "node:sqlite is not available. The index needs Node 22 or later.",
      { cause: error },
    );
  } finally {
    process.emitWarning = emitWarning;
  }
}
