import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexWorkspace, openIndex } from "../src/index.js";
import { makeWorkspace } from "./helpers.js";

describe("index counts", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("reports files, symbols, chunks and edges that match what was indexed", async () => {
    const ws = makeWorkspace({
      "src/a.ts": "export function one(): number {\n  return 1;\n}\n",
      "src/b.ts":
        'import { one } from "./a";\nexport function two(): number {\n  return one() + 1;\n}\n',
    });
    cleanup = ws.cleanup;
    const dbPath = join(ws.root, ".index.sqlite");
    await indexWorkspace(ws.root, { dbPath });
    const store = openIndex(dbPath);
    try {
      expect(store.fileCount()).toBe(2);
      expect(store.symbolCount()).toBeGreaterThanOrEqual(2);
      expect(store.chunkCount()).toBe(store.symbolCount());
      expect(store.edgeCount()).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("reports zero for an empty index", () => {
    const ws = makeWorkspace({});
    cleanup = ws.cleanup;
    const store = openIndex(join(ws.root, ".empty.sqlite"));
    try {
      expect([
        store.fileCount(),
        store.symbolCount(),
        store.edgeCount(),
        store.chunkCount(),
      ]).toEqual([0, 0, 0, 0]);
    } finally {
      store.close();
    }
  });
});
