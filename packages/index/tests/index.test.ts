import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type IndexStore, indexWorkspace, openIndex } from "../src/index.js";
import { type Workspace, makeWorkspace, removeFile, writeFile } from "./helpers.js";

let ws: Workspace;
let store: IndexStore | undefined;

function open(): IndexStore {
  store?.close();
  store = openIndex(ws.dbPath);
  return store;
}

function symbolId(s: IndexStore, qualified: string): number {
  const file = s.listFiles().find((f) => s.symbolsByQualified(f.id, qualified).length > 0);
  if (file === undefined) {
    throw new Error(`no symbol ${qualified}`);
  }
  const found = s.symbolsByQualified(file.id, qualified)[0];
  if (found === undefined) {
    throw new Error(`no symbol ${qualified}`);
  }
  return found.id;
}

beforeEach(() => {
  ws = makeWorkspace({
    "src/util.ts":
      "/** Clamp a value. */\nexport function clamp(v: number): number {\n  return v;\n}\n",
    "src/app.ts":
      "import { clamp } from './util';\nexport function run(x: number) {\n  return clamp(x);\n}\n",
  });
});

afterEach(() => {
  store?.close();
  store = undefined;
  ws.cleanup();
});

describe("indexWorkspace incremental behaviour", () => {
  it("indexes every file on the first run and skips unchanged files on the second", async () => {
    const first = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(first.filesScanned).toBe(2);
    expect(first.filesChanged).toBe(2);
    expect(first.filesRemoved).toBe(0);
    expect(first.ms).toBeGreaterThanOrEqual(0);

    const before = open();
    const clampId = symbolId(before, "clamp");
    before.close();
    store = undefined;

    const second = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(second.filesScanned).toBe(2);
    expect(second.filesChanged).toBe(0);
    expect(second.filesRemoved).toBe(0);
    expect(symbolId(open(), "clamp")).toBe(clampId);
  });

  it("re-extracts only the changed file and keeps ids of unchanged symbols", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const clampId = symbolId(s, "clamp");
    s.close();
    store = undefined;

    writeFile(
      ws.root,
      "src/util.ts",
      "export function clamp(v: number): number {\n  return v;\n}\nexport const LIMIT = 9;\n",
    );
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(summary.filesChanged).toBe(1);

    const after = open();
    expect(symbolId(after, "clamp")).toBe(clampId);
    expect(symbolId(after, "LIMIT")).toBeGreaterThan(0);
    const utilFile = after.fileByPath("src/util.ts");
    expect(utilFile).toBeDefined();
    const names = after.symbolsInFile(utilFile?.id ?? -1).map((x) => x.qualified);
    expect(names).toEqual(["clamp", "LIMIT"]);
  });

  it("removes rows, edges and chunks for deleted files", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const appFile = s.fileByPath("src/app.ts");
    expect(appFile).toBeDefined();
    const runId = symbolId(s, "run");
    expect(s.neighbors(runId, ["calls"]).length).toBe(1);
    s.close();
    store = undefined;

    removeFile(ws.root, "src/app.ts");
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(summary.filesRemoved).toBe(1);
    expect(summary.filesScanned).toBe(1);

    const after = open();
    expect(after.fileByPath("src/app.ts")).toBeUndefined();
    expect(after.fileById(appFile?.id ?? -1)).toBeUndefined();
    expect(after.search("run", 10).length).toBe(0);
    expect(after.edgesOfKind("calls")).toEqual([]);
    expect(after.edgesOfKind("imports")).toEqual([]);
    expect(after.chunkCount()).toBe(1);
  });

  it("picks up a new file and a new import target", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    writeFile(ws.root, "src/extra.ts", "export function extra(): number {\n  return 1;\n}\n");
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(summary.filesChanged).toBe(1);
    expect(summary.filesScanned).toBe(3);
    expect(symbolId(open(), "extra")).toBeGreaterThan(0);
  });
});

describe("indexWorkspace symbols, edges and search", () => {
  it("resolves imports to files and calls to symbols", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const app = s.fileByPath("src/app.ts");
    const util = s.fileByPath("src/util.ts");
    expect(app).toBeDefined();
    expect(util).toBeDefined();
    const imports = s.neighborFiles(app?.id ?? -1, ["imports"]);
    expect(imports).toEqual([{ fileId: util?.id, kind: "imports", weight: 1, direction: "out" }]);

    const run = symbolId(s, "run");
    const clamp = symbolId(s, "clamp");
    expect(s.neighbors(run, ["calls"])).toEqual([
      { symbolId: clamp, kind: "calls", weight: 1, direction: "out" },
    ]);
    expect(s.neighbors(clamp, ["calls"])).toEqual([
      { symbolId: run, kind: "calls", weight: 1, direction: "in" },
    ]);
  });

  it("returns symbol and file records by id", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const clamp = s.symbolById(symbolId(s, "clamp"));
    expect(clamp).toMatchObject({
      name: "clamp",
      qualified: "clamp",
      kind: "function",
      exported: true,
      startLine: 2,
      endLine: 4,
      doc: "Clamp a value.",
    });
    expect(clamp?.signature).toBe("export function clamp(v: number): number");
    const file = s.fileById(clamp?.fileId ?? -1);
    expect(file?.path).toBe("src/util.ts");
    expect(file?.lang).toBe("ts");
    expect(file?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ranks the symbol whose name and doc match the query first", async () => {
    ws.cleanup();
    ws = makeWorkspace({
      "src/net.ts": [
        "/** Retry a flaky request with exponential backoff. */",
        "export function retryWithBackoff(fn: () => void): void {",
        "  fn();",
        "}",
        "export function formatDate(d: Date): string {",
        "  // no retry here, just formatting",
        "  return d.toISOString();",
        "}",
        "",
      ].join("\n"),
      "src/config.ts":
        "export function parseConfig(text: string): object {\n  return JSON.parse(text);\n}\n",
    });
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const hits = s.search("retry backoff", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.symbolId).toBe(symbolId(s, "retryWithBackoff"));
    expect(hits[0]?.score).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]?.score ?? 0).toBeGreaterThanOrEqual(hits[i]?.score ?? 0);
    }
    expect(s.search("parse config", 5)[0]?.symbolId).toBe(symbolId(s, "parseConfig"));
    expect(s.search("retry", 1)).toHaveLength(1);
  });

  it("treats FTS syntax in the query as plain text and returns nothing for empty queries", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    expect(s.search('"clamp" OR NEAR(', 5).length).toBeGreaterThan(0);
    expect(s.search("   ", 5)).toEqual([]);
    expect(s.search("clamp", 0)).toEqual([]);
  });

  it("tags symbol edges with the requested minimum weight", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const run = symbolId(s, "run");
    expect(s.neighbors(run, ["calls"], 0.5)).toHaveLength(1);
    expect(s.neighbors(run, ["calls"], 1.5)).toHaveLength(0);
    expect(s.neighbors(run, ["tests"])).toEqual([]);
  });
});

describe("indexWorkspace exclude and tsconfig paths", () => {
  it("honours the exclude globs passed in options", async () => {
    writeFile(ws.root, "src/gen/big.ts", "export const big = 1;\n");
    await indexWorkspace(ws.root, { dbPath: ws.dbPath, exclude: ["src/gen/**"] });
    const s = open();
    expect(s.fileByPath("src/gen/big.ts")).toBeUndefined();
    expect(s.fileByPath("src/util.ts")).toBeDefined();
  });

  it("resolves tsconfig path aliases through the TypeScript module resolver", async () => {
    ws.cleanup();
    ws = makeWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/lib/*"] } },
      }),
      "src/lib/math.ts": "export function square(n: number): number {\n  return n * n;\n}\n",
      "src/main.ts":
        "import { square } from '@lib/math';\nexport function area(s: number): number {\n  return square(s);\n}\n",
      "src/esm.ts":
        "import { square } from './lib/math.js';\nexport function twice(n: number): number {\n  return square(n) * 2;\n}\n",
    });
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const math = s.fileByPath("src/lib/math.ts");
    const main = s.fileByPath("src/main.ts");
    const esm = s.fileByPath("src/esm.ts");
    expect(math && main && esm).toBeTruthy();
    expect(s.neighborFiles(main?.id ?? -1, ["imports"])).toEqual([
      { fileId: math?.id, kind: "imports", weight: 1, direction: "out" },
    ]);
    expect(s.neighborFiles(esm?.id ?? -1, ["imports"]).map((n) => n.fileId)).toEqual([math?.id]);
    const area = symbolId(s, "area");
    expect(s.neighbors(area, ["calls"]).map((n) => n.symbolId)).toEqual([symbolId(s, "square")]);
  });

  it("resolves the import to a tsconfig base directory when no paths are set", async () => {
    ws.cleanup();
    ws = makeWorkspace({
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
      "src/shared/id.ts": "export function id(): number {\n  return 1;\n}\n",
      "src/use.ts": "import { id } from 'shared/id';\nexport function use() {\n  return id();\n}\n",
    });
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const use = s.fileByPath("src/use.ts");
    expect(s.neighborFiles(use?.id ?? -1, ["imports"]).map((n) => n.fileId)).toEqual([
      s.fileByPath("src/shared/id.ts")?.id,
    ]);
  });
});

describe("indexWorkspace test edges", () => {
  it("links test cases to the symbols they call", async () => {
    ws.cleanup();
    ws = makeWorkspace({
      "src/math.ts":
        "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n",
      "src/math.test.ts": [
        "import { add } from './math';",
        "describe('math', () => {",
        "  it('adds', () => {",
        "    expect(add(1, 2)).toBe(3);",
        "  });",
        "});",
        "",
      ].join("\n"),
      "src/math.spec.ts":
        "import { mul } from './math';\nit('multiplies', () => {\n  mul(2, 3);\n});\n",
    });
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    const adds = symbolId(s, "math > adds");
    const multiplies = symbolId(s, "multiplies");
    expect(s.symbolById(adds)?.kind).toBe("test");
    expect(s.neighbors(adds, ["tests"]).map((n) => n.symbolId)).toEqual([symbolId(s, "add")]);
    expect(s.neighbors(multiplies, ["tests"]).map((n) => n.symbolId)).toEqual([symbolId(s, "mul")]);
    expect(s.edgesOfKind("calls")).toEqual([]);
  });
});

describe("indexWorkspace embeddings", () => {
  it("writes no vectors when no embedder is passed", async () => {
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    const s = open();
    expect(s.chunksMissingVectors(100).length).toBe(s.chunkCount());
    expect(s.getMeta("embed_model")).toBeUndefined();
  });

  it("stores vectors from the embedder and ranks by cosine similarity", async () => {
    const embedder = {
      model: "fake",
      dimensions: 2,
      embed: async (texts: readonly string[]): Promise<Float32Array[]> =>
        texts.map((text) =>
          text.includes("Clamp a value") ? new Float32Array([1, 0]) : new Float32Array([0, 1]),
        ),
    };
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath, embedder });
    expect(summary.warnings).toEqual([]);
    const s = open();
    expect(s.chunksMissingVectors(100)).toEqual([]);
    expect(s.getMeta("embed_model")).toBe("fake:2");
    const hits = s.vectorSearch(new Float32Array([1, 0]), 2);
    expect(hits[0]?.symbolId).toBe(symbolId(s, "clamp"));
    expect(hits[0]?.score).toBeCloseTo(1);
  });

  it("keeps indexing and reports a warning when the embedder fails", async () => {
    const embedder = {
      model: "broken",
      dimensions: 2,
      embed: async (): Promise<Float32Array[]> => {
        throw new Error("model not loaded");
      },
    };
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath, embedder });
    expect(summary.warnings.length).toBe(1);
    expect(summary.warnings[0]).toContain("model not loaded");
    const s = open();
    expect(s.search("clamp", 5).length).toBeGreaterThan(0);
  });
});
