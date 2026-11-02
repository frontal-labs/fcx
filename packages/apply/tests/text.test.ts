import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EditError, applyEditsToText, resolveInWorkspace, sha256 } from "../src/index.js";

describe("applyEditsToText", () => {
  it("applies edits in order, so a later edit sees the earlier result", () => {
    expect(
      applyEditsToText("a b", [
        { search: "a", replace: "x" },
        { search: "x b", replace: "done" },
      ]),
    ).toBe("done");
  });

  it("normalizes CRLF in both the file and the search text", () => {
    expect(applyEditsToText("one\r\ntwo\r\n", [{ search: "one\ntwo", replace: "1\n2" }])).toBe(
      "1\n2\n",
    );
  });

  it("rejects an empty search", () => {
    expect(() => applyEditsToText("x", [{ search: "", replace: "y" }])).toThrow(EditError);
  });

  it("reports a search that is not in the file", () => {
    expect(() => applyEditsToText("x", [{ search: "z", replace: "y" }])).toThrowError(
      expect.objectContaining({ code: "ANCHOR_NOT_FOUND" }),
    );
  });

  it("reports a search that matches more than once", () => {
    expect(() => applyEditsToText("x x", [{ search: "x", replace: "y" }])).toThrowError(
      expect.objectContaining({ code: "ANCHOR_NOT_UNIQUE" }),
    );
  });

  it("leaves text unchanged when there are no edits", () => {
    expect(applyEditsToText("keep\n", [])).toBe("keep\n");
  });
});

describe("sha256", () => {
  it("matches the known digest of the empty string", () => {
    expect(sha256("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("resolveInWorkspace", () => {
  let root: string;
  let workspace: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-resolve-"));
    workspace = join(root, "ws");
    mkdirSync(workspace);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves a relative path to an absolute path inside the workspace", () => {
    writeFileSync(join(workspace, "a.ts"), "");
    expect(resolveInWorkspace(workspace, "a.ts")).toBe(join(workspace, "a.ts"));
  });

  it("accepts an absolute path that is inside the workspace", () => {
    expect(resolveInWorkspace(workspace, join(workspace, "new.ts"))).toBe(
      join(workspace, "new.ts"),
    );
  });

  it("refuses the workspace root itself", () => {
    expect(() => resolveInWorkspace(workspace, ".")).toThrow(/escapes/);
  });
});
