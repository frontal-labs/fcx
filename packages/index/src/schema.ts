import type { DatabaseSync } from "./sqlite.js";

/** Bump when the layout changes. Existing databases with another version are rejected. */
export const SCHEMA_VERSION = 1;

/**
 * Graph store schema (plan section 8.1). Deviations, recorded in docs/DECISIONS.md:
 * - `chunk_fts` is kept in sync by triggers on `chunks`, so cascade deletes update FTS.
 * - `chunk_vec` is a plain table of Float32 BLOBs, because `sqlite-vec` is not a dependency.
 * - `edges` has no foreign keys; the store removes edges that point at deleted rows.
 */
const DDL: readonly string[] = [
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
  `CREATE TABLE files (
     id INTEGER PRIMARY KEY,
     path TEXT NOT NULL UNIQUE,
     lang TEXT,
     hash TEXT NOT NULL,
     mtime INTEGER NOT NULL,
     size INTEGER NOT NULL
   )`,
  `CREATE TABLE symbols (
     id INTEGER PRIMARY KEY,
     file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     qualified TEXT NOT NULL,
     kind TEXT NOT NULL,
     start_line INTEGER NOT NULL,
     end_line INTEGER NOT NULL,
     signature TEXT NOT NULL,
     doc TEXT NOT NULL,
     exported INTEGER NOT NULL
   )`,
  "CREATE INDEX symbols_name ON symbols(name)",
  "CREATE INDEX symbols_file ON symbols(file_id)",
  `CREATE TABLE edges (
     src INTEGER NOT NULL,
     dst INTEGER NOT NULL,
     kind TEXT NOT NULL,
     weight REAL NOT NULL DEFAULT 1,
     PRIMARY KEY (src, dst, kind)
   )`,
  "CREATE INDEX edges_dst ON edges(dst, kind)",
  `CREATE TABLE chunks (
     id INTEGER PRIMARY KEY,
     symbol_id INTEGER NOT NULL UNIQUE REFERENCES symbols(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     tokens INTEGER NOT NULL
   )`,
  `CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61')`,
  `CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
     INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
   END`,
  `CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
     INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
   END`,
  `CREATE TRIGGER chunks_au AFTER UPDATE OF text ON chunks BEGIN
     INSERT INTO chunk_fts(chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
     INSERT INTO chunk_fts(rowid, text) VALUES (new.id, new.text);
   END`,
  `CREATE TABLE chunk_vec (
     chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
     embedding BLOB NOT NULL
   )`,
  // Dependency APIs (plan section 8.2, item 9). Filled by a later milestone.
  `CREATE TABLE deps (
     id INTEGER PRIMARY KEY,
     lang TEXT NOT NULL,
     package TEXT NOT NULL,
     version TEXT,
     symbol TEXT NOT NULL,
     kind TEXT,
     signature TEXT
   )`,
  "CREATE INDEX deps_lookup ON deps(lang, package, symbol)",
  // Local memory (plan section 12.1). Written by the memory package, not by the indexer.
  `CREATE TABLE memory (
     id INTEGER PRIMARY KEY,
     symbol_id INTEGER,
     file_id INTEGER,
     kind TEXT,
     text TEXT NOT NULL,
     source TEXT,
     created_at INTEGER NOT NULL
   )`,
];

/** Creates every table in an empty database and records the schema version. */
export function createSchema(db: DatabaseSync): void {
  db.exec("BEGIN");
  try {
    for (const statement of DDL) {
      db.exec(statement);
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
