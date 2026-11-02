import { rmSync } from "node:fs";
import { join } from "node:path";
import { indexWorkspace } from "@fcx/index";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { retrieve } from "../src/index.js";
import type { ContextBundle, RetrieveTask } from "../src/index.js";
import { createFixture, fakeEmbedder } from "./fixture.js";

const TWO_HOPS_SCORE = (1 / 61) * 0.25; // target score (no hits, so 1/61), two calls-edges of weight 1

describe("retrieve", () => {
  let root: string;
  let dbPath: string;

  beforeAll(async () => {
    root = createFixture();
    dbPath = join(root, "index.sqlite");
    await indexWorkspace(root, { dbPath });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (task: Partial<RetrieveTask>, extra: Partial<Parameters<typeof retrieve>[1]> = {}) =>
    retrieve({ workspace: root, ...task }, { dbPath, skipIndex: true, ...extra });

  const find = (bundle: ContextBundle, why: string) => bundle.blocks.find((b) => b.why === why);

  it("always includes the target symbol, found by name or by file and line", async () => {
    const byName = await run({ symbol: "startApp", text: "unrelated words" });
    expect(byName.metadata.targetFound).toBe(true);
    expect(byName.blocks[0]?.why).toBe("target symbol");
    expect(byName.blocks[0]?.text).toContain("export function startApp");

    const byLine = await run({ file: join(root, "src", "app.ts"), line: 4 });
    expect(byLine.blocks[0]?.why).toBe("target symbol");
    expect(byLine.blocks[0]?.file).toBe("src/app.ts");
    expect(byLine.blocks[0]?.startLine).toBe(3);
    expect(byLine.blocks[0]?.endLine).toBe(6);
  });

  it("keeps the target even when no ranked hit matches the text", async () => {
    const bundle = await run({ symbol: "startApp", text: "qwertyuiop asdfgh" });
    expect(find(bundle, "target symbol")).toBeDefined();
  });

  it("reports when no target matches, and still returns ranked blocks", async () => {
    const bundle = await run({ symbol: "doesNotExist", text: "parse config" });
    expect(bundle.metadata.targetFound).toBe(false);
    expect(bundle.metadata.notes).toContain("no target symbol matched the task");
    expect(find(bundle, "target symbol")).toBeUndefined();
    expect(bundle.blocks.length).toBeGreaterThan(0);
  });

  it("scores two-hop nodes by the exact decay and packs them as signatures only", async () => {
    const bundle = await run({ symbol: "startApp" });
    const loadConfig = bundle.blocks.find((b) =>
      b.text.includes("return parseConfig(readRaw(path));"),
    );
    expect(loadConfig?.score).toBeCloseTo(0.5 / 61, 12); // one hop, weight 1

    const parse = bundle.blocks.find((b) => b.text.startsWith("export function parseConfig"));
    expect(parse).toBeDefined();
    expect(parse?.score).toBeCloseTo(TWO_HOPS_SCORE, 12);
    expect(parse?.text).toBe("export function parseConfig(raw: string): Config");
    expect(parse?.startLine).toBe(parse?.endLine);
    expect(parse?.text).not.toContain("split");
  });

  it("adds one sibling example of the target's kind from the same file", async () => {
    const bundle = await run({ symbol: "startApp" });
    const sibling = find(bundle, "sibling example");
    expect(sibling?.file).toBe("src/app.ts");
    expect(sibling?.text).toContain("export function stopApp");
  });

  it("includes the error text as a required block", async () => {
    const bundle = await run({
      file: join(root, "src", "app.ts"),
      line: 4,
      errorText: "TypeError: config.name is not a function",
    });
    expect(bundle.blocks[0]?.why).toBe("target symbol");
    const error = find(bundle, "error text");
    expect(error?.text).toBe("TypeError: config.name is not a function");
    expect(error?.file).toBe("src/app.ts");
    expect(error?.startLine).toBe(4);
  });

  it("builds the allow-lists from the packed blocks and the workspace package.json", async () => {
    const bundle = await run({ symbol: "startApp" });
    expect(bundle.allowLists.paths).toContain("src/app.ts");
    expect(bundle.allowLists.paths).toContain("src/loader.ts");
    expect(bundle.allowLists.symbolsInScope).toContain("startApp");
    expect(bundle.allowLists.symbolsInScope).toContain("parseConfig");
    expect(bundle.allowLists.importablePackages).toEqual(["vitest", "zod"]);
    expect([...bundle.allowLists.paths]).toEqual([...bundle.allowLists.paths].sort());
  });

  it("reports the budget, the used tokens, and dropped blocks", async () => {
    const bundle = await run({ symbol: "startApp" }, { contextBudgetTokens: 10 });
    expect(bundle.metadata.budgetTokens).toBe(10);
    expect(bundle.metadata.droppedBlocks).toBeGreaterThan(0);
    // The target and the sibling example are required, so they are kept whatever the budget.
    const required = bundle.blocks.filter(
      (b) => b.why === "target symbol" || b.why === "sibling example",
    );
    const requiredTokens = required.reduce((sum, b) => sum + Math.ceil(b.text.length / 3.5), 0);
    expect(bundle.blocks[0]?.why).toBe("target symbol");
    expect(bundle.metadata.usedTokens).toBe(requiredTokens);
  });

  it("keeps the required blocks with a tiny budget and drops the rest", async () => {
    const bundle = await run(
      {
        symbol: "startApp",
        errorText: "TypeError: boom",
        file: join(root, "src", "app.ts"),
        line: 4,
      },
      { contextBudgetTokens: 1 },
    );
    expect(bundle.blocks.map((b) => b.why)).toEqual([
      "target symbol",
      "error text",
      "sibling example",
    ]);
    expect(bundle.metadata.droppedBlocks).toBeGreaterThan(0);
    expect(bundle.metadata.usedTokens).toBeGreaterThan(bundle.metadata.budgetTokens);
  });

  it("skips the vector side and says so when there is no embedder", async () => {
    const bundle = await run({ symbol: "startApp", text: "parse config" });
    expect(bundle.metadata.vectorSide).toBe(false);
    expect(bundle.metadata.notes.some((n) => n.includes("no embedder"))).toBe(true);
  });

  it("is deterministic: the same index and input give the same bundle", async () => {
    const task: RetrieveTask = {
      workspace: root,
      symbol: "startApp",
      text: "parse config name retries",
      errorText: "Error: config retries",
    };
    const first = await retrieve(task, { dbPath, skipIndex: true, contextBudgetTokens: 400 });
    const second = await retrieve(task, { dbPath, skipIndex: true, contextBudgetTokens: 400 });
    expect(second).toEqual(first);
  });

  it("uses the vector side when an embedder is given and the index has vectors", async () => {
    const embedder = fakeEmbedder();
    const vectorDb = join(root, "vectors.sqlite");
    await indexWorkspace(root, { dbPath: vectorDb, embedder });
    const bundle = await retrieve(
      { workspace: root, symbol: "startApp", text: "parse config" },
      { dbPath: vectorDb, embedder, skipIndex: true },
    );
    expect(bundle.metadata.vectorSide).toBe(true);
    expect(bundle.blocks[0]?.why).toBe("target symbol");
  });

  it("skips the vector side when the index was built with another embedder", async () => {
    const bundle = await run(
      { symbol: "startApp", text: "parse config" },
      { embedder: fakeEmbedder(4) },
    );
    expect(bundle.metadata.vectorSide).toBe(false);
    expect(bundle.metadata.notes.some((n) => n.includes("not built with"))).toBe(true);
  });

  it("refreshes the index before retrieving unless skipIndex is set", async () => {
    const fresh = join(root, "fresh.sqlite");
    const bundle = await retrieve({ workspace: root, symbol: "startApp" }, { dbPath: fresh });
    expect(bundle.metadata.targetFound).toBe(true);
  });
});
