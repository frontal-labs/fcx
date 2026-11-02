import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyRust } from "../src/rust.js";
import { type TempTree, hasExecutable, hashFile, makeWorkspace } from "./helpers.js";

const haveCargo = hasExecutable("cargo");

const CARGO_TOML = '[package]\nname = "fcxtest"\nversion = "0.1.0"\nedition = "2021"\n';
const CLEAN = 'fn main() {\n    let x = 1;\n    println!("{}", x);\n}\n';
const BROKEN = 'fn main() {\n    println!("{}", y);\n}\n';

describe.skipIf(!haveCargo)("verifyRust round trip (cargo installed)", () => {
  let ws: TempTree;
  let scratchRoot: string;

  beforeEach(async () => {
    ws = await makeWorkspace({ "Cargo.toml": CARGO_TOML, "src/main.rs": CLEAN });
    scratchRoot = await mkdtemp(join(tmpdir(), "fcx-verify-test-scratch-"));
  });

  afterEach(async () => {
    await ws.cleanup();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  it("a clean candidate yields no errors", async () => {
    const result = await verifyRust({
      workspace: ws.root,
      file: join(ws.root, "src/main.rs"),
      candidateText: CLEAN.replace("let x = 1", "let x = 2"),
      tempRoot: scratchRoot,
    });
    expect(result.language).toBe("rust");
    expect(result.available).toBe(true);
    expect(result.errors).toEqual([]);
  }, 130_000);

  it("a candidate with a deliberate error reports the right line", async () => {
    const result = await verifyRust({
      workspace: ws.root,
      file: join(ws.root, "src/main.rs"),
      candidateText: BROKEN,
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.line).toBe(2);
    expect(result.errors[0]?.message).toContain("cannot find value `y` in this scope");
  }, 130_000);

  it("never writes to the real workspace and removes its scratch directory", async () => {
    const file = join(ws.root, "src/main.rs");
    const before = await hashFile(file);
    await verifyRust({ workspace: ws.root, file, candidateText: BROKEN, tempRoot: scratchRoot });
    expect(await hashFile(file)).toBe(before);
    expect(await readdir(scratchRoot)).toEqual([]);
  }, 130_000);

  it("refuses a file outside src/ because cargo check would not cover it", async () => {
    const result = await verifyRust({
      workspace: ws.root,
      file: join(ws.root, "tests/t.rs"),
      candidateText: "fn main() {}\n",
      tempRoot: scratchRoot,
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe("cargo check covers only files under src/");
  });
});
