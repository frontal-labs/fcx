import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coChangePairs } from "../src/git.js";
import { type IndexStore, indexWorkspace, openIndex } from "../src/index.js";
import { type Workspace, git, makeWorkspace } from "./helpers.js";

let ws: Workspace;
let store: IndexStore | undefined;

beforeEach(() => {
  ws = makeWorkspace({});
});

afterEach(() => {
  store?.close();
  store = undefined;
  ws.cleanup();
});

function commit(files: Record<string, string>, message: string): void {
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(ws.root, rel), content);
  }
  git(ws.root, ["add", "-A"]);
  git(ws.root, ["commit", "-q", "-m", message]);
}

describe("coChangePairs", () => {
  it("counts shared commits, drops pairs under the minimum and weights by the smaller change count", () => {
    const commits = [
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "b.ts"],
      ["a.ts"],
      ["a.ts", "c.ts"],
      ["a.ts", "c.ts"],
    ];
    const pairs = coChangePairs(commits, new Set(["a.ts", "b.ts", "c.ts"]));
    expect(pairs).toEqual([{ a: "a.ts", b: "b.ts", count: 3, weight: 1 }]);
  });

  it("uses count / min(changes) for the weight", () => {
    const commits = [["a.ts", "b.ts"], ["a.ts", "b.ts"], ["a.ts", "b.ts"], ["b.ts"], ["b.ts"]];
    const [pair] = coChangePairs(commits, new Set(["a.ts", "b.ts"]));
    expect(pair?.weight).toBeCloseTo(3 / 3);
    const extra = coChangePairs([...commits, ["a.ts"], ["a.ts"]], new Set(["a.ts", "b.ts"]));
    expect(extra[0]?.weight).toBeCloseTo(3 / 5);
  });

  it("ignores unknown files and commits touching too many files", () => {
    const big = Array.from({ length: 4 }, (_, i) => `f${i}.ts`);
    const commits = [big, big, big, ["a.ts", "gone.ts"], ["a.ts", "gone.ts"], ["a.ts", "gone.ts"]];
    const known = new Set([...big, "a.ts"]);
    expect(coChangePairs(commits, known, 3, 3)).toEqual([]);
    expect(coChangePairs(commits, known, 3, 50)).toHaveLength(6);
  });
});

describe("indexWorkspace co-change edges from git history", () => {
  it("adds weighted co_changes edges for pairs that changed together at least three times", async () => {
    git(ws.root, ["init", "-q"]);
    commit({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" }, "init");
    commit({ "a.ts": "export const a = 2;\n", "b.ts": "export const b = 2;\n" }, "two");
    commit({ "a.ts": "export const a = 3;\n", "b.ts": "export const b = 3;\n" }, "three");
    commit({ "a.ts": "export const a = 4;\n" }, "solo");
    commit({ "a.ts": "export const a = 5;\n", "c.ts": "export const c = 1;\n" }, "with c");
    commit({ "a.ts": "export const a = 6;\n", "c.ts": "export const c = 2;\n" }, "with c again");

    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    store = openIndex(ws.dbPath);
    const a = store.fileByPath("a.ts");
    const b = store.fileByPath("b.ts");
    const c = store.fileByPath("c.ts");
    expect(a && b && c).toBeTruthy();
    // Edges are stored in both directions, so each side sees the pair as "out" and "in".
    const fromA = store
      .neighborFiles(a?.id ?? -1, ["co_changes"])
      .map((n) => `${n.direction}:${n.fileId}:${n.weight}`);
    expect(fromA.sort()).toEqual([`in:${b?.id ?? -1}:1`, `out:${b?.id ?? -1}:1`]);
    const fromB = store.neighborFiles(b?.id ?? -1, ["co_changes"]).map((n) => n.fileId);
    expect([...new Set(fromB)]).toEqual([a?.id]);
    expect(store.neighborFiles(c?.id ?? -1, ["co_changes"])).toEqual([]);
  });

  it("adds no co_changes edges when the workspace is not a git repository", async () => {
    writeFileSync(join(ws.root, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(ws.root, "b.ts"), "export const b = 1;\n");
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    store = openIndex(ws.dbPath);
    expect(store.edgesOfKind("co_changes")).toEqual([]);
  });
});
