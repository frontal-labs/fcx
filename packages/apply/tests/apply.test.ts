import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  StaleFileError,
  applyPlan,
  planEdits,
  resolveInWorkspace,
  undoLatest,
} from "../src/index.js";

describe("apply", () => {
  let root: string;
  let workspace: string;
  let undoRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-apply-"));
    workspace = join(root, "ws");
    undoRoot = join(root, "undo");
    mkdirSync(workspace);
  });

  afterEach(() => {
    chmodSync(workspace, 0o755);
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a symbolic link, even one that points inside the workspace", () => {
    writeFileSync(join(workspace, "real.ts"), "x\n");
    symlinkSync(join(workspace, "real.ts"), join(workspace, "link.ts"));
    expect(() => resolveInWorkspace(workspace, "link.ts")).toThrow(/symbolic link/);
  });

  it("refuses a path whose real location is outside the workspace", () => {
    const outside = join(root, "secret.ts");
    writeFileSync(outside, "secret\n");
    // A directory symlink inside the workspace that leads out of it.
    symlinkSync(root, join(workspace, "escape"));
    expect(() => resolveInWorkspace(workspace, "escape/secret.ts")).toThrow(
      /outside the workspace|escapes/,
    );
  });

  it("refuses a lexical escape", () => {
    expect(() => resolveInWorkspace(workspace, "../secret.ts")).toThrow(/escapes the workspace/);
  });

  it("keeps the file's permission bits when it rewrites a file", () => {
    const file = join(workspace, "run.sh");
    writeFileSync(file, "echo a\n");
    chmodSync(file, 0o755);
    const plan = planEdits(workspace, [{ file: "run.sh", search: "echo a", replace: "echo b" }]);
    applyPlan(plan, undoRoot);
    expect(readFileSync(file, "utf-8")).toBe("echo b\n");
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });

  it("refuses to write when the file changed after the edits were verified", () => {
    const file = join(workspace, "a.ts");
    writeFileSync(file, "const a = 1;\n");
    const verifiedText = "const a = 1;\n";
    const plan = planEdits(
      workspace,
      [{ file: "a.ts", search: "const a = 1;", replace: "const a = 2;" }],
      new Map([[file, verifiedText]]),
    );
    // The user edits the file after verification, before the write.
    writeFileSync(file, "const a = 99;\n");
    expect(() => applyPlan(plan, undoRoot)).toThrow(StaleFileError);
    expect(readFileSync(file, "utf-8")).toBe("const a = 99;\n");
  });

  it("writes nothing when a second file cannot be staged", () => {
    const first = join(workspace, "a.ts");
    const dir = join(workspace, "locked");
    mkdirSync(dir);
    const second = join(dir, "b.ts");
    writeFileSync(first, "one\n");
    writeFileSync(second, "two\n");
    const plan = planEdits(workspace, [
      { file: "a.ts", search: "one", replace: "uno" },
      { file: "locked/b.ts", search: "two", replace: "dos" },
    ]);
    chmodSync(dir, 0o555);
    try {
      expect(() => applyPlan(plan, undoRoot)).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(readFileSync(first, "utf-8")).toBe("one\n");
    expect(readFileSync(second, "utf-8")).toBe("two\n");
  });

  it("undo restores the original and refuses a file changed since", () => {
    const file = join(workspace, "a.ts");
    writeFileSync(file, "alpha\n");
    const applied = applyPlan(
      planEdits(workspace, [{ file: "a.ts", search: "alpha", replace: "beta" }]),
      undoRoot,
    );
    expect(applied.files).toHaveLength(1);

    writeFileSync(file, "beta\nlater edit\n");
    expect(() => undoLatest(undoRoot, workspace)).toThrow(/changed since/);

    writeFileSync(file, "beta\n");
    undoLatest(undoRoot, workspace);
    expect(readFileSync(file, "utf-8")).toBe("alpha\n");
  });
});
