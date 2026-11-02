import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type * as Sqlite from "node:sqlite";
import { importAgentsConventions } from "./instructions";
import { insertRecord, normalizeRecord, rowToRecord } from "./records";
import { DEFAULT_BUDGET_TOKENS, selectNeighborhood } from "./retrieve";
import { ensureSchema, loadSqlite } from "./schema";
import type {
  ImportResult,
  MemoryFilter,
  MemoryRecord,
  NeighborhoodResult,
  NewMemoryRecord,
  RecordInput,
} from "./types";

function whereClause(filter: MemoryFilter): { sql: string; params: Sqlite.SQLInputValue[] } {
  const conditions: string[] = [];
  const params: Sqlite.SQLInputValue[] = [];
  if (filter.kind !== undefined) {
    conditions.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.filePath !== undefined) {
    conditions.push("file_path = ?");
    params.push(filter.filePath);
  }
  if (filter.symbol !== undefined) {
    conditions.push("symbol = ?");
    params.push(filter.symbol);
  }
  return {
    sql: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

/** Local project memory. Every record stays in this database file. Nothing is sent anywhere. */
export class MemoryStore {
  readonly #db: Sqlite.DatabaseSync;

  constructor(db: Sqlite.DatabaseSync) {
    this.#db = db;
  }

  /** Stores a record after validation and secret rejection. */
  remember(record: NewMemoryRecord): MemoryRecord {
    const normalized = normalizeRecord(record);
    const id = insertRecord(this.#db, normalized, null, Date.now());
    const row = this.#db.prepare("SELECT * FROM memory WHERE id = ?").get(id);
    if (row === undefined) {
      throw new Error("inserted memory record not found");
    }
    return rowToRecord(row);
  }

  /** Records matching the filter, newest first. */
  list(filter: MemoryFilter = {}): MemoryRecord[] {
    const where = whereClause(filter);
    return this.#db
      .prepare(`SELECT * FROM memory${where.sql} ORDER BY created_at DESC, id DESC`)
      .all(...where.params)
      .map(rowToRecord);
  }

  /** Deletes one record. Returns false when no record has that id. */
  forget(id: number): boolean {
    const result = this.#db.prepare("DELETE FROM memory WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  /** Deletes the records matching the filter (all records when no filter). Returns the count. */
  clear(filter: MemoryFilter = {}): number {
    const where = whereClause(filter);
    const result = this.#db.prepare(`DELETE FROM memory${where.sql}`).run(...where.params);
    return Number(result.changes);
  }

  /**
   * Records attached to any of the files or symbols, ordered by kind (convention, accepted_fix,
   * rejected) and then newest first, trimmed to budgetTokens. Tokens are approximated (see
   * approximateTokens).
   */
  forNeighborhood(
    files: readonly string[],
    symbols: readonly string[],
    budgetTokens: number = DEFAULT_BUDGET_TOKENS,
  ): NeighborhoodResult {
    return selectNeighborhood(this.#db, files, symbols, budgetTokens);
  }

  recordAcceptedFix(input: RecordInput): MemoryRecord {
    return this.remember({ ...input, kind: "accepted_fix", source: input.source ?? "auto" });
  }

  recordRejected(input: RecordInput): MemoryRecord {
    return this.remember({ ...input, kind: "rejected", source: input.source ?? "auto" });
  }

  /** Stores each AGENTS.md section under root as a convention. Repeated imports do not duplicate. */
  importConventions(root: string): ImportResult {
    return importAgentsConventions(this.#db, root);
  }

  close(): void {
    this.#db.close();
  }
}

/** Opens (creating if needed) the memory database at path. Refuses other schema versions. */
export function openMemory(path: string): MemoryStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  try {
    ensureSchema(db);
  } catch (error) {
    db.close();
    throw error;
  }
  return new MemoryStore(db);
}
