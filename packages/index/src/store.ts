import { IndexError } from "./errors.js";
import { SCHEMA_VERSION, createSchema } from "./schema.js";
import { buildFtsQuery, cosineSimilarity } from "./search.js";
import { loadSqlite } from "./sqlite.js";
import type { DatabaseSync, StatementSync } from "./sqlite.js";
import { FILE_EDGE_KINDS, SYMBOL_EDGE_KINDS } from "./types.js";
import type {
  EdgeInput,
  EdgeKind,
  FileEdgeKind,
  FileInput,
  FileNeighbor,
  FileRecord,
  Neighbor,
  SearchHit,
  SymbolEdgeKind,
  SymbolInput,
  SymbolKind,
  SymbolRecord,
  VectorHit,
} from "./types.js";

type Row = Record<string, number | bigint | string | Uint8Array | null>;

const SYMBOL_KINDS_SQL = SYMBOL_EDGE_KINDS.map((kind) => `'${kind}'`).join(",");
const FILE_KINDS_SQL = FILE_EDGE_KINDS.map((kind) => `'${kind}'`).join(",");

function int(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new IndexError("MALFORMED_DATABASE", "", `expected integer column ${key}`);
}

function real(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  throw new IndexError("MALFORMED_DATABASE", "", `expected numeric column ${key}`);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value === "string") {
    return value;
  }
  throw new IndexError("MALFORMED_DATABASE", "", `expected text column ${key}`);
}

function textOrNull(row: Row, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function blob(row: Row, key: string): Uint8Array {
  const value = row[key];
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new IndexError("MALFORMED_DATABASE", "", `expected blob column ${key}`);
}

function toFileRecord(row: Row): FileRecord {
  return {
    id: int(row, "id"),
    path: text(row, "path"),
    lang: textOrNull(row, "lang"),
    hash: text(row, "hash"),
    mtime: int(row, "mtime"),
    size: int(row, "size"),
  };
}

function toSymbolRecord(row: Row): SymbolRecord {
  return {
    id: int(row, "id"),
    fileId: int(row, "file_id"),
    name: text(row, "name"),
    qualified: text(row, "qualified"),
    kind: text(row, "kind") as SymbolKind,
    startLine: int(row, "start_line"),
    endLine: int(row, "end_line"),
    signature: text(row, "signature"),
    doc: text(row, "doc"),
    exported: int(row, "exported") === 1,
  };
}

function symbolKey(kind: string, qualified: string): string {
  return `${kind}\u0000${qualified}`;
}

/**
 * Typed access to the index database. Use `openIndex` to create one. Write methods are
 * synchronous; wrap several of them in `transaction` to batch the work.
 */
export class IndexStore {
  readonly dbPath: string;
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(dbPath: string, db: DatabaseSync) {
    this.dbPath = dbPath;
    this.#db = db;
  }

  #prepare(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached) {
      return cached;
    }
    const statement = this.#db.prepare(sql);
    this.#statements.set(sql, statement);
    return statement;
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }

  /** Runs `fn` inside one transaction. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) {
      return fn();
    }
    this.#db.exec("BEGIN IMMEDIATE");
    this.#depth += 1;
    try {
      const result = fn();
      this.#depth -= 1;
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#depth = 0;
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getMeta(key: string): string | undefined {
    const row = this.#prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? undefined : text(row, "value");
  }

  setMeta(key: string, value: string): void {
    this.#prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  listFiles(): FileRecord[] {
    return this.#prepare("SELECT * FROM files ORDER BY path").all().map(toFileRecord);
  }

  fileByPath(path: string): FileRecord | undefined {
    const row = this.#prepare("SELECT * FROM files WHERE path = ?").get(path);
    return row === undefined ? undefined : toFileRecord(row);
  }

  fileById(id: number): FileRecord | undefined {
    const row = this.#prepare("SELECT * FROM files WHERE id = ?").get(id);
    return row === undefined ? undefined : toFileRecord(row);
  }

  /** Inserts or updates a file row by path. The id is stable across updates. */
  upsertFile(input: FileInput): number {
    this.#prepare(
      `INSERT INTO files (path, lang, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         lang = excluded.lang, hash = excluded.hash, mtime = excluded.mtime, size = excluded.size`,
    ).run(input.path, input.lang, input.hash, input.mtime, input.size);
    const row = this.#prepare("SELECT id FROM files WHERE path = ?").get(input.path);
    if (row === undefined) {
      throw new IndexError("MALFORMED_DATABASE", this.dbPath, "file row missing after upsert");
    }
    return int(row, "id");
  }

  /** Deletes a file and everything under it: symbols, chunks, vectors and edges. */
  removeFile(fileId: number): void {
    this.transaction(() => {
      this.#prepare(
        `DELETE FROM edges WHERE kind IN (${SYMBOL_KINDS_SQL}) AND (
           src IN (SELECT id FROM symbols WHERE file_id = ?) OR
           dst IN (SELECT id FROM symbols WHERE file_id = ?))`,
      ).run(fileId, fileId);
      this.#prepare(
        `DELETE FROM edges WHERE kind IN (${FILE_KINDS_SQL}) AND (src = ? OR dst = ?)`,
      ).run(fileId, fileId);
      this.#prepare("DELETE FROM files WHERE id = ?").run(fileId);
    });
  }

  symbolById(id: number): SymbolRecord | undefined {
    const row = this.#prepare("SELECT * FROM symbols WHERE id = ?").get(id);
    return row === undefined ? undefined : toSymbolRecord(row);
  }

  symbolsInFile(fileId: number): SymbolRecord[] {
    return this.#prepare("SELECT * FROM symbols WHERE file_id = ? ORDER BY start_line, id")
      .all(fileId)
      .map(toSymbolRecord);
  }

  /** Symbols in one file with the given qualified name (any kind). */
  symbolsByQualified(fileId: number, qualified: string): SymbolRecord[] {
    return this.#prepare("SELECT * FROM symbols WHERE file_id = ? AND qualified = ? ORDER BY id")
      .all(fileId, qualified)
      .map(toSymbolRecord);
  }

  /**
   * Makes the file's symbols match `inputs`. Symbols are matched by (kind, qualified name), so
   * unchanged symbols keep their ids and their incoming edges. Chunks are rewritten when their
   * text changes. Returns the symbol id for each input, in input order.
   */
  replaceSymbols(fileId: number, inputs: readonly SymbolInput[]): number[] {
    return this.transaction(() => {
      const existing = this.#prepare(
        "SELECT id, kind, qualified FROM symbols WHERE file_id = ? ORDER BY id",
      ).all(fileId);
      const pool = new Map<string, number[]>();
      for (const row of existing) {
        const key = symbolKey(text(row, "kind"), text(row, "qualified"));
        const list = pool.get(key) ?? [];
        list.push(int(row, "id"));
        pool.set(key, list);
      }
      const ids: number[] = [];
      const kept = new Set<number>();
      for (const input of inputs) {
        const key = symbolKey(input.kind, input.qualified);
        const candidates = pool.get(key);
        const reused = candidates?.shift();
        let symbolId: number;
        if (reused === undefined) {
          const result = this.#prepare(
            `INSERT INTO symbols (file_id, name, qualified, kind, start_line, end_line, signature, doc, exported)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            fileId,
            input.name,
            input.qualified,
            input.kind,
            input.startLine,
            input.endLine,
            input.signature,
            input.doc,
            input.exported ? 1 : 0,
          );
          symbolId = Number(result.lastInsertRowid);
        } else {
          symbolId = reused;
          this.#prepare(
            `UPDATE symbols SET name = ?, start_line = ?, end_line = ?, signature = ?, doc = ?, exported = ?
             WHERE id = ?`,
          ).run(
            input.name,
            input.startLine,
            input.endLine,
            input.signature,
            input.doc,
            input.exported ? 1 : 0,
            symbolId,
          );
        }
        kept.add(symbolId);
        ids.push(symbolId);
        this.#upsertChunk(symbolId, input.chunkText, input.tokens);
      }
      const stale = existing.map((row) => int(row, "id")).filter((id) => !kept.has(id));
      for (const id of stale) {
        this.#deleteSymbolEdges(id);
        this.#prepare("DELETE FROM symbols WHERE id = ?").run(id);
      }
      return ids;
    });
  }

  #upsertChunk(symbolId: number, chunkText: string, tokens: number): void {
    const row = this.#prepare("SELECT id, text FROM chunks WHERE symbol_id = ?").get(symbolId);
    if (row === undefined) {
      this.#prepare("INSERT INTO chunks (symbol_id, text, tokens) VALUES (?, ?, ?)").run(
        symbolId,
        chunkText,
        tokens,
      );
      return;
    }
    if (text(row, "text") === chunkText) {
      return;
    }
    const chunkId = int(row, "id");
    this.#prepare("UPDATE chunks SET text = ?, tokens = ? WHERE id = ?").run(
      chunkText,
      tokens,
      chunkId,
    );
    this.#prepare("DELETE FROM chunk_vec WHERE chunk_id = ?").run(chunkId);
  }

  #deleteSymbolEdges(symbolId: number): void {
    this.#prepare(
      `DELETE FROM edges WHERE kind IN (${SYMBOL_KINDS_SQL}) AND (src = ? OR dst = ?)`,
    ).run(symbolId, symbolId);
  }

  /**
   * Deletes the edges that a re-extraction of this file recomputes: symbol edges that start
   * in its symbols, and its outgoing `imports` edges. Incoming edges from other files stay.
   */
  clearOutgoingEdges(fileId: number): void {
    this.transaction(() => {
      this.#prepare(
        `DELETE FROM edges WHERE kind IN (${SYMBOL_KINDS_SQL}) AND
           src IN (SELECT id FROM symbols WHERE file_id = ?)`,
      ).run(fileId);
      this.#prepare("DELETE FROM edges WHERE kind = 'imports' AND src = ?").run(fileId);
    });
  }

  /** Inserts an edge, or updates the weight of an existing edge with the same key. */
  addEdge(edge: EdgeInput): void {
    this.#prepare(
      `INSERT INTO edges (src, dst, kind, weight) VALUES (?, ?, ?, ?)
       ON CONFLICT(src, dst, kind) DO UPDATE SET weight = excluded.weight`,
    ).run(edge.src, edge.dst, edge.kind, edge.weight);
  }

  /** Deletes every edge of a file-level kind (used before recomputing co-change edges). */
  deleteEdgesOfKind(kind: FileEdgeKind): void {
    this.#prepare("DELETE FROM edges WHERE kind = ?").run(kind);
  }

  /** Symbol-level edges touching `symbolId` (in either direction), filtered by kind and weight. */
  neighbors(symbolId: number, kinds: readonly SymbolEdgeKind[], minWeight = 0): Neighbor[] {
    if (kinds.length === 0) {
      return [];
    }
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.#prepare(
      `SELECT src, dst, kind, weight FROM edges
       WHERE kind IN (${placeholders}) AND weight >= ? AND (src = ? OR dst = ?)
       ORDER BY weight DESC, dst, src`,
    ).all(...kinds, minWeight, symbolId, symbolId);
    return rows.map((row) => {
      const outgoing = int(row, "src") === symbolId;
      return {
        symbolId: outgoing ? int(row, "dst") : int(row, "src"),
        kind: text(row, "kind") as SymbolEdgeKind,
        weight: real(row, "weight"),
        direction: outgoing ? "out" : "in",
      };
    });
  }

  /** File-level edges (`imports`, `co_changes`) touching `fileId`, filtered by kind and weight. */
  neighborFiles(fileId: number, kinds: readonly FileEdgeKind[], minWeight = 0): FileNeighbor[] {
    if (kinds.length === 0) {
      return [];
    }
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.#prepare(
      `SELECT src, dst, kind, weight FROM edges
       WHERE kind IN (${placeholders}) AND weight >= ? AND (src = ? OR dst = ?)
       ORDER BY weight DESC, dst, src`,
    ).all(...kinds, minWeight, fileId, fileId);
    return rows.map((row) => {
      const outgoing = int(row, "src") === fileId;
      return {
        fileId: outgoing ? int(row, "dst") : int(row, "src"),
        kind: text(row, "kind") as FileEdgeKind,
        weight: real(row, "weight"),
        direction: outgoing ? "out" : "in",
      };
    });
  }

  /** Edges of one kind, for inspection and tests. */
  edgesOfKind(kind: EdgeKind): { src: number; dst: number; weight: number }[] {
    return this.#prepare("SELECT src, dst, weight FROM edges WHERE kind = ? ORDER BY src, dst")
      .all(kind)
      .map((row) => ({
        src: int(row, "src"),
        dst: int(row, "dst"),
        weight: real(row, "weight"),
      }));
  }

  /** BM25-ranked chunk search. Returns at most `limit` hits, best first. */
  search(query: string, limit: number): SearchHit[] {
    const match = buildFtsQuery(query);
    if (match === undefined || limit <= 0) {
      return [];
    }
    const rows = this.#prepare(
      `SELECT c.id AS chunk_id, c.symbol_id AS symbol_id, bm25(chunk_fts) AS rank
       FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid
       WHERE chunk_fts MATCH ?
       ORDER BY rank, c.id
       LIMIT ?`,
    ).all(match, limit);
    return rows.map((row) => ({
      chunkId: int(row, "chunk_id"),
      symbolId: int(row, "symbol_id"),
      score: -real(row, "rank"),
    }));
  }

  /** Chunks that have no vector yet, oldest first. */
  chunksMissingVectors(limit: number): { id: number; text: string }[] {
    return this.#prepare(
      `SELECT c.id AS id, c.text AS text FROM chunks c
       LEFT JOIN chunk_vec v ON v.chunk_id = c.id
       WHERE v.chunk_id IS NULL ORDER BY c.id LIMIT ?`,
    )
      .all(limit)
      .map((row) => ({ id: int(row, "id"), text: text(row, "text") }));
  }

  putVectors(rows: readonly { chunkId: number; vector: Float32Array }[]): void {
    this.transaction(() => {
      for (const row of rows) {
        const bytes = new Uint8Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength,
        );
        this.#prepare(
          "INSERT INTO chunk_vec (chunk_id, embedding) VALUES (?, ?) ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding",
        ).run(row.chunkId, bytes);
      }
    });
  }

  clearVectors(): void {
    this.#prepare("DELETE FROM chunk_vec").run();
  }

  /** Brute-force cosine search over stored vectors. Returns at most `limit` hits, best first. */
  vectorSearch(query: Float32Array, limit: number): VectorHit[] {
    if (limit <= 0) {
      return [];
    }
    const hits: VectorHit[] = [];
    for (const row of this.#prepare(
      `SELECT v.chunk_id AS chunk_id, c.symbol_id AS symbol_id, v.embedding AS embedding
       FROM chunk_vec v JOIN chunks c ON c.id = v.chunk_id`,
    ).all()) {
      const copy = blob(row, "embedding").slice();
      const vector = new Float32Array(
        copy.buffer,
        0,
        copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      hits.push({
        chunkId: int(row, "chunk_id"),
        symbolId: int(row, "symbol_id"),
        score: cosineSimilarity(query, vector),
      });
    }
    hits.sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
    return hits.slice(0, limit);
  }

  chunkCount(): number {
    return this.#count("chunks");
  }

  /** Number of indexed files. */
  fileCount(): number {
    return this.#count("files");
  }

  /** Number of extracted symbols. */
  symbolCount(): number {
    return this.#count("symbols");
  }

  /** Number of edges of every kind. */
  edgeCount(): number {
    return this.#count("edges");
  }

  #count(table: "chunks" | "files" | "symbols" | "edges"): number {
    const row = this.#prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return row === undefined ? 0 : int(row, "n");
  }
}

/** Looks up an open index. A missing file is created with the current schema. */
export function openIndex(path: string): IndexStore {
  const sqlite = loadSqlite(path);
  let db: DatabaseSync;
  try {
    db = new sqlite.DatabaseSync(path);
  } catch (error) {
    throw new IndexError(
      "MALFORMED_DATABASE",
      path,
      `cannot open index database: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get();
    const tableCount = tables === undefined ? 0 : int(tables, "n");
    if (tableCount === 0) {
      createSchema(db);
      return new IndexStore(path, db);
    }
    const check = db.prepare("PRAGMA quick_check").get();
    if (check === undefined || textOrNull(check, "quick_check") !== "ok") {
      throw new IndexError("MALFORMED_DATABASE", path, "index database failed quick_check");
    }
    const meta = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      .get();
    if (meta === undefined) {
      throw new IndexError(
        "MALFORMED_DATABASE",
        path,
        "database has no meta table; not an fcx index",
      );
    }
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    const found = version === undefined ? undefined : textOrNull(version, "value");
    if (found === undefined || found === null) {
      throw new IndexError("MALFORMED_DATABASE", path, "index database has no schema_version");
    }
    if (found !== String(SCHEMA_VERSION)) {
      throw new IndexError(
        "SCHEMA_VERSION_MISMATCH",
        path,
        `index schema version ${found} does not match ${SCHEMA_VERSION}; delete the file to rebuild`,
      );
    }
    return new IndexStore(path, db);
  } catch (error) {
    db.close();
    if (error instanceof IndexError) {
      throw error;
    }
    throw new IndexError(
      "MALFORMED_DATABASE",
      path,
      `index database is malformed: ${String(error)}`,
      {
        cause: error,
      },
    );
  }
}
