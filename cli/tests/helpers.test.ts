import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FixReport, parseTarget } from "../src/commands/fix.js";
import { formatFix } from "../src/lib/format.js";
import { indexPathFor, memoryPathFor, repoKey, undoRootFor } from "../src/lib/repo.js";
import { candidateBudget } from "../src/lib/runtime.js";
import { applyUndo } from "../src/lib/undo.js";

describe("parseTarget", () => {
  it("splits a file and an optional line", () => {
    expect(parseTarget("src/a.ts:12")).toEqual({ file: "src/a.ts", line: 12 });
    expect(parseTarget("src/a.ts")).toEqual({ file: "src/a.ts", line: undefined });
  });

  it("rejects line 0 and an empty file", () => {
    expect(() => parseTarget("src/a.ts:0")).toThrow(/line numbers start at 1/);
    expect(() => parseTarget(":3")).toThrow(/expected a file/);
  });
});

describe("candidateBudget", () => {
  it("uses an explicit numeric setting as given", () => {
    expect(candidateBudget({ maxCandidates: 3 } as never)).toBe(3);
  });

  it("chooses 4 or 6 from RAM when the setting is auto", () => {
    const n = candidateBudget({ maxCandidates: "auto" } as never);
    expect([4, 6]).toContain(n);
  });
});

describe("repoKey and undoRootFor", () => {
  it("is stable for the same workspace and 16 hex characters long", () => {
    expect(repoKey("/tmp/some-repo")).toBe(repoKey("/tmp/some-repo"));
    expect(repoKey("/tmp/some-repo")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates different workspaces", () => {
    expect(repoKey("/tmp/a")).not.toBe(repoKey("/tmp/b"));
  });

  it("places undo history under the cache directory", () => {
    expect(undoRootFor("/cache", "/tmp/a")).toBe(join("/cache", "undo", repoKey("/tmp/a")));
  });

  it("places memory and index databases per repo under the cache directory", () => {
    expect(memoryPathFor("/cache", "/tmp/a")).toBe(
      join("/cache", "memory", `${repoKey("/tmp/a")}.sqlite`),
    );
    expect(indexPathFor("/cache", "/tmp/a")).toBe(
      join("/cache", "index", `${repoKey("/tmp/a")}.sqlite`),
    );
  });
});

describe("formatFix", () => {
  const base: FixReport = {
    status: "proposed",
    recipe: "fix-diagnostic",
    file: "/repo/src/a.ts",
    diagnostic: {
      file: "/repo/src/a.ts",
      line: 5,
      column: 1,
      code: 2322,
      message: "bad",
      category: "error",
    },
    edits: [{ file: "src/a.ts", search: "old", replace: "new" }],
    candidates: [],
    escalationOffered: false,
    instructions: "",
    warnings: [],
    context: { source: "checker", notes: [] },
    timings: { totalMs: 7 },
  };

  it("shows the status, the error and the proposed edit", () => {
    const text = formatFix(base);
    expect(text).toContain("proposed");
    expect(text).toContain("TS2322 bad");
    expect(text).toContain("- old");
    expect(text).toContain("+ new");
  });

  it("says an abstained result was not applied", () => {
    expect(formatFix({ ...base, status: "abstained", lastError: "still present" })).toMatch(
      /not verified; not applied/,
    );
  });

  it("gives the undo id after an applied change", () => {
    expect(formatFix({ ...base, status: "applied", undoId: "abc" })).toContain(
      "undo with: fcx undo (id abc)",
    );
  });

  it("shows the hint for a failed run", () => {
    const text = formatFix({
      ...base,
      status: "error",
      error: { code: "FIX_FAILED", message: "x", hint: "run pull" },
    });
    expect(text).toContain("hint: run pull");
  });
});

describe("applyUndo", () => {
  let cache: string;

  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "fcx-undo-cli-"));
  });

  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it("reports an error, not a crash, when there is nothing to undo", () => {
    const result = applyUndo(cache, "/tmp/never-used");
    expect(result).toEqual({ status: "error", message: "nothing to undo" });
  });
});
