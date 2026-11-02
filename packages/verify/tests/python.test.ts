import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPython } from "../src/python.js";
import { type TempTree, hasExecutable, hasPyflakes, hashFile, makeWorkspace } from "./helpers.js";

const havePython = hasExecutable("python3");
const havePyflakes = havePython && hasPyflakes();

const CLEAN = "def add(a, b):\n    return a + b\n";
const SYNTAX_ERROR = "def add(a, b)\n    return a + b\n";
const UNUSED_IMPORT = "import os\n\n\ndef f():\n    return 1\n";

describe.skipIf(!havePython)("verifyPython round trip (python3 installed)", () => {
  let ws: TempTree;
  let scratchRoot: string;

  beforeEach(async () => {
    ws = await makeWorkspace({ "app.py": CLEAN });
    scratchRoot = await mkdtemp(join(tmpdir(), "fcx-verify-test-scratch-"));
  });

  afterEach(async () => {
    await ws.cleanup();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("a clean candidate yields no errors", async () => {
    const result = await verifyPython({
      workspace: ws.root,
      file: join(ws.root, "app.py"),
      candidateText: CLEAN.replace("add", "plus"),
      tempRoot: scratchRoot,
    });
    expect(result.language).toBe("python");
    expect(result.available).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("a syntax error is reported at its line", async () => {
    const result = await verifyPython({
      workspace: ws.root,
      file: join(ws.root, "app.py"),
      candidateText: SYNTAX_ERROR,
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(1);
    expect(result.errors[0]?.message).toContain("SyntaxError");
  });

  it("never writes to the real workspace and removes its scratch directory", async () => {
    const file = join(ws.root, "app.py");
    const before = await hashFile(file);
    await verifyPython({
      workspace: ws.root,
      file,
      candidateText: SYNTAX_ERROR,
      tempRoot: scratchRoot,
    });
    expect(await hashFile(file)).toBe(before);
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

describe.skipIf(!havePyflakes)("verifyPython with pyflakes (pyflakes importable)", () => {
  let ws: TempTree;
  let scratchRoot: string;

  beforeEach(async () => {
    ws = await makeWorkspace({ "app.py": CLEAN });
    scratchRoot = await mkdtemp(join(tmpdir(), "fcx-verify-test-scratch-"));
  });

  afterEach(async () => {
    await ws.cleanup();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("pyflakes findings are reported at their line", async () => {
    const result = await verifyPython({
      workspace: ws.root,
      file: join(ws.root, "app.py"),
      candidateText: UNUSED_IMPORT,
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toEqual([{ line: 1, message: "'os' imported but unused" }]);
  });
});

describe.skipIf(!havePython)("verifyPython ignores repo files named like stdlib modules", () => {
  let ws: TempTree;
  let scratchRoot: string;
  // Importing either planted module would exit with status 7 and the message "planted".
  const PLANTED = 'raise SystemExit("planted")\n';

  beforeEach(async () => {
    ws = await makeWorkspace({ "app.py": CLEAN, "json.py": PLANTED, "pyflakes.py": PLANTED });
    scratchRoot = await mkdtemp(join(tmpdir(), "fcx-verify-test-scratch-"));
  });

  afterEach(async () => {
    await ws.cleanup();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("runs the real stdlib and reports the candidate's own errors", async () => {
    const result = await verifyPython({
      workspace: ws.root,
      file: join(ws.root, "app.py"),
      candidateText: "import json\n\n\ndef add(a, b)\n    return a\n",
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(4);
    expect(result.errors[0]?.message).toContain("SyntaxError");
  });

  it("a clean candidate is not affected by planted modules", async () => {
    const result = await verifyPython({
      workspace: ws.root,
      file: join(ws.root, "app.py"),
      candidateText: "import json\n\n\ndef dump(x):\n    return json.dumps(x)\n",
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.reason).toBeUndefined();
  });
});
