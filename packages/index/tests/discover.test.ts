import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFiles } from "../src/discover.js";
import { compileIgnoreRules, globToRegExpBody, isPathIgnored } from "../src/ignore.js";
import { type Workspace, git, makeWorkspace, removeFile, writeFile } from "./helpers.js";

let ws: Workspace;

beforeEach(() => {
  ws = makeWorkspace({
    "src/a.ts": "export const a = 1;\n",
    "src/b.test.ts": "export const b = 2;\n",
    "node_modules/pkg/index.js": "module.exports = {};\n",
    "dist/out.js": "x\n",
    "target/debug/build.rs": "x\n",
    ".git/HEAD": "ref: refs/heads/main\n",
    "logs/run.log": "noise\n",
    "build/keep.ts": "export {};\n",
    ".gitignore": "logs/\n*.tmp\n",
    "scratch.tmp": "x\n",
  });
});

afterEach(() => ws.cleanup());

describe("discoverFiles (directory walk)", () => {
  it("skips node_modules, .git, dist and target and applies the root .gitignore", async () => {
    const result = await discoverFiles(ws.root, []);
    const paths = result.files.map((f) => f.path);
    expect(result.usedGit).toBe(false);
    expect(paths).toEqual([".gitignore", "build/keep.ts", "src/a.ts", "src/b.test.ts"]);
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist"))).toBe(false);
    expect(paths.some((p) => p.startsWith("target"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths).not.toContain("logs/run.log");
    expect(paths).not.toContain("scratch.tmp");
  });

  it("applies index.exclude globs", async () => {
    const result = await discoverFiles(ws.root, ["**/*.test.ts", "build/**"]);
    const paths = result.files.map((f) => f.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("src/b.test.ts");
    expect(paths).not.toContain("build/keep.ts");
  });

  it("returns files sorted by path with sizes", async () => {
    const result = await discoverFiles(ws.root, []);
    const paths = result.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort());
    const a = result.files.find((f) => f.path === "src/a.ts");
    expect(a?.size).toBe("export const a = 1;\n".length);
  });
});

describe("discoverFiles (git repository)", () => {
  it("lists tracked and untracked files and leaves out ignored ones", async () => {
    git(ws.root, ["init", "-q"]);
    git(ws.root, ["add", "src", ".gitignore"]);
    writeFile(ws.root, "src/untracked.ts", "export const u = 3;\n");
    writeFile(ws.root, "logs/ignored.log", "noise\n");

    const result = await discoverFiles(ws.root, []);
    const paths = result.files.map((f) => f.path);
    expect(result.usedGit).toBe(true);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/untracked.ts");
    expect(paths).not.toContain("logs/ignored.log");
    expect(paths).not.toContain("scratch.tmp");
  });

  it("drops tracked files that were deleted from disk", async () => {
    git(ws.root, ["init", "-q"]);
    git(ws.root, ["add", "src"]);
    removeFile(ws.root, "src/a.ts");
    const result = await discoverFiles(ws.root, []);
    expect(result.files.map((f) => f.path)).not.toContain("src/a.ts");
  });
});

describe("ignore rules", () => {
  it("matches ** globs across directories", () => {
    const rules = compileIgnoreRules(["**/node_modules/**"]);
    expect(isPathIgnored("node_modules/x/y.js", false, rules)).toBe(true);
    expect(isPathIgnored("packages/a/node_modules/x.js", false, rules)).toBe(true);
    expect(isPathIgnored("src/node_modulesx.ts", false, rules)).toBe(false);
  });

  it("supports anchored, unanchored, directory-only and negated rules", () => {
    const rules = compileIgnoreRules(["/root.txt", "*.log", "cache/", "!keep.log"]);
    expect(isPathIgnored("root.txt", false, rules)).toBe(true);
    expect(isPathIgnored("sub/root.txt", false, rules)).toBe(false);
    expect(isPathIgnored("deep/x.log", false, rules)).toBe(true);
    expect(isPathIgnored("keep.log", false, rules)).toBe(false);
    expect(isPathIgnored("cache", true, rules)).toBe(true);
    expect(isPathIgnored("cache", false, rules)).toBe(false);
    expect(isPathIgnored("cache/a.ts", false, rules)).toBe(true);
  });

  it("translates glob syntax", () => {
    expect(globToRegExpBody("a?/*.ts")).toBe("a[^/]/[^/]*\\.ts");
  });
});
