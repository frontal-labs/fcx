import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyGo } from "../src/go.js";
import { type TempTree, hasExecutable, hashFile, makeWorkspace } from "./helpers.js";

const haveGo = hasExecutable("go");

const GO_MOD = "module example.com/fcxtest\n\ngo 1.21\n";
const CLEAN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n';
const BROKEN = 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(undefinedName)\n}\n';

describe.skipIf(!haveGo)("verifyGo round trip (go installed)", () => {
  let ws: TempTree;
  let scratchRoot: string;

  beforeEach(async () => {
    ws = await makeWorkspace({ "go.mod": GO_MOD, "main.go": CLEAN });
    scratchRoot = await mkdtemp(join(tmpdir(), "fcx-verify-test-scratch-"));
  });

  afterEach(async () => {
    await ws.cleanup();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("a clean candidate yields no errors", async () => {
    const result = await verifyGo({
      workspace: ws.root,
      file: join(ws.root, "main.go"),
      candidateText: CLEAN.replace("hi", "hello"),
      tempRoot: scratchRoot,
    });
    expect(result.language).toBe("go");
    expect(result.available).toBe(true);
    expect(result.errors).toEqual([]);
  }, 120_000);

  it("a candidate with a deliberate error reports the right line", async () => {
    const result = await verifyGo({
      workspace: ws.root,
      file: join(ws.root, "main.go"),
      candidateText: BROKEN,
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toContainEqual({ line: 6, message: "undefined: undefinedName" });
  }, 120_000);

  it("never writes to the real workspace and removes its scratch directory", async () => {
    const file = join(ws.root, "main.go");
    const before = await hashFile(file);
    await verifyGo({ workspace: ws.root, file, candidateText: BROKEN, tempRoot: scratchRoot });
    expect(await hashFile(file)).toBe(before);
    expect(await readdir(scratchRoot)).toEqual([]);
  }, 120_000);

  it("drops errors that were already present before the candidate", async () => {
    const result = await verifyGo({
      workspace: ws.root,
      file: join(ws.root, "main.go"),
      candidateText: BROKEN,
      originalErrors: [{ line: 1, message: "undefined: undefinedName" }],
      tempRoot: scratchRoot,
    });
    expect(result.errors).toEqual([]);
  }, 120_000);
});
