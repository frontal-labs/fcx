import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryError, approximateTokens, openMemory } from "../src/index";
import { SCHEMA_VERSION } from "../src/schema";
import { openRawDatabase } from "./helpers";

describe("openMemory and schema version", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fcx-memory-schema-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the database and its parent directory on first open", () => {
    const path = join(dir, "nested", "memory.sqlite");
    const store = openMemory(path);
    store.remember({ kind: "rejected", text: "kept", source: "x" });
    store.close();

    const reopened = openMemory(path);
    expect(reopened.list().map((r) => r.text)).toEqual(["kept"]);
    reopened.close();
  });

  it("records the schema version in the meta table", () => {
    const path = join(dir, "memory.sqlite");
    openMemory(path).close();
    const db = openRawDatabase(path);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    db.close();
    expect(row?.value).toBe(String(SCHEMA_VERSION));
  });

  it("refuses a database with a different schema version", () => {
    const path = join(dir, "memory.sqlite");
    openMemory(path).close();
    const db = openRawDatabase(path);
    db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();

    let caught: unknown;
    try {
      openMemory(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect(caught instanceof MemoryError && caught.code).toBe("schema_mismatch");
    expect(caught instanceof Error && caught.message).toContain("999");
  });

  it("refuses a database that has a memory table but no schema version", () => {
    const path = join(dir, "memory.sqlite");
    const db = openRawDatabase(path);
    db.exec("CREATE TABLE memory(id INTEGER PRIMARY KEY)");
    db.close();

    expect(() => openMemory(path)).toThrow(expect.objectContaining({ code: "schema_mismatch" }));
  });
});

describe("approximateTokens", () => {
  it("counts ceil(characters / 3.5) and returns 0 for empty text", () => {
    expect(approximateTokens("")).toBe(0);
    expect(approximateTokens("a")).toBe(1);
    expect(approximateTokens("a".repeat(7))).toBe(2);
    expect(approximateTokens("a".repeat(8))).toBe(3);
    expect(approximateTokens("a".repeat(35))).toBe(10);
    expect(approximateTokens("a".repeat(36))).toBe(11);
  });
});
