import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openMemory } from "@fcx/memory";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/app.js";
import { parseGlobalArgs } from "../src/args.js";
import { formatMemory, memoryExitCode, runMemory } from "../src/commands/memory.js";
import { memoryPathFor } from "../src/lib/repo.js";
import { type Sandbox, captureLog, makeSandbox } from "./support.js";

describe("fcx memory", () => {
  let sb: Sandbox;
  let path: string;

  beforeEach(() => {
    sb = makeSandbox("fcx-memory-");
    path = memoryPathFor(sb.cache, sb.workspace);
    const store = openMemory(path);
    store.recordAcceptedFix({ text: "fixed A", filePath: "src/a.ts" });
    store.recordRejected({ text: "undone B", filePath: "src/b.ts" });
    store.remember({ kind: "convention", text: "use bun", source: "AGENTS.md" });
    store.close();
  });

  afterEach(() => {
    sb.cleanup();
  });

  it("lists every record as JSON-friendly data", () => {
    const report = runMemory(["list"], path);
    expect(report.status).toBe("ok");
    if (report.status !== "ok" || report.action !== "list") throw new Error("expected a list");
    expect(report.records.map((r) => r.kind).sort()).toEqual([
      "accepted_fix",
      "convention",
      "rejected",
    ]);
    expect(memoryExitCode(report)).toBe(0);
  });

  it("filters the list by kind", () => {
    const report = runMemory(["list", "--kind", "rejected"], path);
    expect(report).toMatchObject({ status: "ok", action: "list" });
    if (report.status !== "ok" || report.action !== "list") throw new Error("expected a list");
    expect(report.records.map((r) => r.text)).toEqual(["undone B"]);
    expect(runMemory(["list", "--kind=convention"], path)).toMatchObject({ status: "ok" });
  });

  it("prints readable text for each record", () => {
    const text = formatMemory(runMemory(["list", "--kind", "accepted_fix"], path));
    expect(text).toContain("[accepted_fix] src/a.ts: fixed A");
    expect(formatMemory(runMemory(["list", "--kind", "rejected"], path))).toMatch(/undone B/);
  });

  it("forgets one record by id, and reports an unknown id as an error", () => {
    const listed = runMemory(["list", "--kind", "rejected"], path);
    if (listed.status !== "ok" || listed.action !== "list") throw new Error("expected a list");
    const id = listed.records[0]?.id ?? -1;

    expect(runMemory(["forget", String(id)], path)).toEqual({ status: "ok", action: "forget", id });
    const again = runMemory(["forget", String(id)], path);
    expect(again).toMatchObject({ status: "error", code: "NOT_FOUND" });
    expect(memoryExitCode(again)).toBe(1);
  });

  it("clears one kind, then everything", () => {
    expect(runMemory(["clear", "--kind", "accepted_fix"], path)).toEqual({
      status: "ok",
      action: "clear",
      kind: "accepted_fix",
      removed: 1,
    });
    expect(runMemory(["clear"], path)).toEqual({ status: "ok", action: "clear", removed: 2 });
    expect(formatMemory(runMemory(["list"], path))).toBe("no memory records");
  });

  it("rejects an unknown kind, an unknown flag and a missing id with usage errors", () => {
    expect(runMemory(["list", "--kind", "bogus"], path)).toMatchObject({ code: "USAGE" });
    expect(runMemory(["list", "--kindd", "rejected"], path)).toMatchObject({ code: "USAGE" });
    expect(runMemory(["forget"], path)).toMatchObject({ code: "USAGE" });
    expect(runMemory(["nope"], path)).toMatchObject({ code: "USAGE" });
  });

  it("reports an unusable database as an error, not a crash", () => {
    const blocker = join(sb.root, "blocker");
    writeFileSync(blocker, "a file, not a directory");
    const report = runMemory(["list"], join(blocker, "memory.sqlite"));
    expect(report).toMatchObject({ status: "error", code: "MEMORY_UNAVAILABLE" });
  });

  it("runs from the CLI with JSON output, through the cache directory override", async () => {
    const { code, lines } = await captureLog(() =>
      run(parseGlobalArgs(["-C", sb.workspace, "--output-format", "json", "memory", "list"])),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { status: string; records: unknown[] };
    expect(parsed.status).toBe("ok");
    expect(parsed.records).toHaveLength(3);
  });
});

describe("memory writes around fix and undo", { timeout: 30_000 }, () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-memory-writes-");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    sb.cleanup();
  });

  async function fixOnce(memoryPath: string | undefined) {
    const { runFixCommand } = await import("../src/commands/fix.js");
    const { undoRootFor } = await import("../src/lib/repo.js");
    const { scriptedModel, GOOD_EDIT } = await import("./support.js");
    return runFixCommand({
      workspace: sb.workspace,
      target: "src/a.ts:5",
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 4,
      model: scriptedModel([GOOD_EDIT]),
      approve: async () => false,
      undoRoot: undoRootFor(sb.cache, sb.workspace),
      logsDir: join(sb.cache, "logs"),
      memoryPath,
    });
  }

  it("records an accepted fix with its file, line, diagnostic code and edit count", async () => {
    const path = memoryPathFor(sb.cache, sb.workspace);
    const report = await fixOnce(path);
    expect(report.status).toBe("applied");
    expect(report.warnings).toEqual([]);

    const store = openMemory(path);
    const records = store.list({ kind: "accepted_fix" });
    store.close();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ filePath: "src/a.ts", source: "auto" });
    expect(records[0]?.text).toContain("TS2322");
    expect(records[0]?.text).toContain("line 5");
    expect(records[0]?.text).toContain("with 1 edit(s)");
  });

  it("applies the fix and reports a warning when memory cannot be written", async () => {
    // A regular file where the memory directory should be makes every memory write fail.
    mkdirSync(sb.cache, { recursive: true });
    const blocker = join(sb.cache, "blocked");
    writeFileSync(blocker, "not a directory");
    const report = await fixOnce(join(blocker, "memory.sqlite"));

    expect(report.status).toBe("applied");
    expect(report.undoId).toBeTruthy();
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toMatch(/^memory not updated/);
  });

  it("records a rejected entry after fcx undo, and undo still succeeds when memory fails", async () => {
    const path = memoryPathFor(sb.cache, sb.workspace);
    const report = await fixOnce(path);
    expect(report.status).toBe("applied");

    const { code, lines } = await captureLog(() =>
      run(parseGlobalArgs(["-C", sb.workspace, "--output-format", "json", "undo"])),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ status: "ok", warnings: [] });

    const store = openMemory(path);
    const rejected = store.list({ kind: "rejected" });
    store.close();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.filePath).toBe("src/a.ts");
  });

  it("keeps undo successful when its memory write fails", async () => {
    const report = await fixOnce(undefined);
    expect(report.status).toBe("applied");

    // The memory directory path is occupied by a file, so the undo's memory write fails.
    writeFileSync(join(sb.cache, "memory"), "occupied");
    const { code, lines } = await captureLog(() =>
      run(parseGlobalArgs(["-C", sb.workspace, "--output-format", "json", "undo"])),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join("\n")) as { status: string; warnings: string[] };
    expect(parsed.status).toBe("ok");
    expect(parsed.warnings).toHaveLength(1);
  });
});
