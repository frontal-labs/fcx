import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  IndexError,
  type IndexStore,
  SCHEMA_VERSION,
  indexWorkspace,
  openIndex,
} from "../src/index.js";
import { loadSqlite } from "../src/sqlite.js";
import { type Workspace, makeWorkspace } from "./helpers.js";

let ws: Workspace;
let opened: IndexStore[] = [];

function open(path: string = ws.dbPath): IndexStore {
  const store = openIndex(path);
  opened = [...opened, store];
  return store;
}

beforeEach(() => {
  ws = makeWorkspace({ "src/a.ts": "export function a(): number {\n  return 1;\n}\n" });
});

afterEach(() => {
  for (const store of opened) {
    store.close();
  }
  opened = [];
  ws.cleanup();
});

describe("schema and open", () => {
  it("creates a new database with the current schema version", () => {
    const store = open();
    expect(store.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
    expect(store.listFiles()).toEqual([]);
    expect(store.chunkCount()).toBe(0);
  });

  it("reopens an existing database without changing it", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const first = open();
    expect(first.fileByPath("src/a.ts")).toBeDefined();
    first.close();
    opened = [];
    const again = open();
    expect(again.fileByPath("src/a.ts")).toBeDefined();
    expect(again.getMeta("schema_version")).toBe(String(SCHEMA_VERSION));
  });

  it("rejects a file that is not a SQLite database with a MALFORMED_DATABASE error", () => {
    writeFileSync(
      ws.dbPath,
      "this is definitely not a sqlite database, just text padding padding\n",
    );
    let caught: unknown;
    try {
      open();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexError);
    expect((caught as IndexError).code).toBe("MALFORMED_DATABASE");
    expect((caught as IndexError).dbPath).toBe(ws.dbPath);
  });

  it("rejects a SQLite database that has no index schema", () => {
    const Sqlite = loadSqlite(ws.dbPath);
    const db = new Sqlite.DatabaseSync(ws.dbPath);
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();
    expect(() => open()).toThrow(expect.objectContaining({ code: "MALFORMED_DATABASE" }));
  });

  it("rejects a database with a different schema version", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const Sqlite = loadSqlite(ws.dbPath);
    const db = new Sqlite.DatabaseSync(ws.dbPath);
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();
    let caught: unknown;
    try {
      open();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IndexError);
    expect((caught as IndexError).code).toBe("SCHEMA_VERSION_MISMATCH");
  });

  it("surfaces a malformed database from indexWorkspace as the same typed error", async () => {
    writeFileSync(ws.dbPath, "garbage garbage garbage garbage garbage garbage garbage garbage\n");
    await expect(indexWorkspace(ws.root, { dbPath: ws.dbPath })).rejects.toMatchObject({
      name: "IndexError",
      code: "MALFORMED_DATABASE",
    });
  });
});

describe("store writes and reads", () => {
  it("upserts files by path and keeps the id", () => {
    const store = open();
    const id = store.upsertFile({ path: "x.ts", lang: "ts", hash: "h1", mtime: 1, size: 2 });
    const again = store.upsertFile({ path: "x.ts", lang: "ts", hash: "h2", mtime: 3, size: 4 });
    expect(again).toBe(id);
    expect(store.fileById(id)).toEqual({
      id,
      path: "x.ts",
      lang: "ts",
      hash: "h2",
      mtime: 3,
      size: 4,
    });
  });

  it("stores symbols and reads them back by file and qualified name", () => {
    const store = open();
    const fileId = store.upsertFile({ path: "x.ts", lang: "ts", hash: "h", mtime: 0, size: 0 });
    const [id] = store.replaceSymbols(fileId, [
      {
        name: "run",
        qualified: "Svc.run",
        kind: "method",
        startLine: 3,
        endLine: 5,
        signature: "run(): void",
        doc: "Runs it.",
        exported: true,
        chunkText: "Svc.run run(): void Runs it.",
        tokens: 5,
      },
    ]);
    expect(id).toBeDefined();
    expect(store.symbolsByQualified(fileId, "Svc.run")[0]).toMatchObject({
      id,
      fileId,
      name: "run",
      kind: "method",
      doc: "Runs it.",
      exported: true,
    });
    expect(store.search("nonexistent", 5)).toEqual([]);
    expect(store.search("runs it", 5)[0]?.symbolId).toBe(id);
  });

  it("keeps edges between symbols in one place and filters them by kind and weight", () => {
    const store = open();
    const fileId = store.upsertFile({ path: "x.ts", lang: "ts", hash: "h", mtime: 0, size: 0 });
    const ids = store.replaceSymbols(fileId, [
      {
        name: "a",
        qualified: "a",
        kind: "function",
        startLine: 1,
        endLine: 1,
        signature: "a",
        doc: "",
        exported: false,
        chunkText: "a",
        tokens: 1,
      },
      {
        name: "b",
        qualified: "b",
        kind: "function",
        startLine: 2,
        endLine: 2,
        signature: "b",
        doc: "",
        exported: false,
        chunkText: "b",
        tokens: 1,
      },
    ]);
    const [a = -1, b = -1] = ids;
    store.addEdge({ src: a, dst: b, kind: "calls", weight: 0.4 });
    store.addEdge({ src: a, dst: b, kind: "calls", weight: 0.9 });
    expect(store.neighbors(a, ["calls"])).toEqual([
      { symbolId: b, kind: "calls", weight: 0.9, direction: "out" },
    ]);
    expect(store.neighbors(b, ["calls"], 0.95)).toEqual([]);
    expect(store.neighbors(a, [])).toEqual([]);
    store.clearOutgoingEdges(fileId);
    expect(store.neighbors(a, ["calls"])).toEqual([]);
  });

  it("removes a file's symbols, chunks and edges when the file is removed", () => {
    const store = open();
    const fileId = store.upsertFile({ path: "x.ts", lang: "ts", hash: "h", mtime: 0, size: 0 });
    const ids = store.replaceSymbols(fileId, [
      {
        name: "gone",
        qualified: "gone",
        kind: "function",
        startLine: 1,
        endLine: 1,
        signature: "gone",
        doc: "",
        exported: false,
        chunkText: "gone unique token",
        tokens: 3,
      },
    ]);
    const [gone = -1] = ids;
    store.addEdge({ src: gone, dst: gone, kind: "tests", weight: 1 });
    store.removeFile(fileId);
    expect(store.fileById(fileId)).toBeUndefined();
    expect(store.symbolById(gone)).toBeUndefined();
    expect(store.search("unique", 5)).toEqual([]);
    expect(store.edgesOfKind("tests")).toEqual([]);
    expect(store.chunkCount()).toBe(0);
  });

  it("rolls back a transaction that throws", () => {
    const store = open();
    expect(() =>
      store.transaction(() => {
        store.upsertFile({ path: "rolled.ts", lang: "ts", hash: "h", mtime: 0, size: 0 });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.fileByPath("rolled.ts")).toBeUndefined();
  });
});
