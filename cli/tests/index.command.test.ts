import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/app.js";
import { parseGlobalArgs } from "../src/args.js";
import { formatIndex, parseIndexArgs, removeIndexFiles, runIndex } from "../src/commands/index.js";
import { indexPathFor } from "../src/lib/repo.js";
import { SOURCE, type Sandbox, captureLog, makeSandbox, writeTsProject } from "./support.js";

describe("parseIndexArgs", () => {
  it("accepts --rebuild and --status, alone or with nothing", () => {
    expect(parseIndexArgs([])).toEqual({ rebuild: false, status: false });
    expect(parseIndexArgs(["--rebuild"])).toEqual({ rebuild: true, status: false });
    expect(parseIndexArgs(["--status"])).toEqual({ rebuild: false, status: true });
  });

  it("rejects unknown flags and the --status plus --rebuild combination", () => {
    expect(parseIndexArgs(["--bogus"])).toMatch(/unknown argument/);
    expect(parseIndexArgs(["--status", "--rebuild"])).toMatch(/cannot be combined/);
  });
});

describe("fcx index", () => {
  let sb: Sandbox;
  let dbPath: string;

  beforeEach(() => {
    sb = makeSandbox("fcx-index-");
    writeTsProject(sb.workspace, `${SOURCE}\nexport function helper(): number {\n  return 1;\n}\n`);
    dbPath = indexPathFor(sb.cache, sb.workspace);
  });

  afterEach(() => {
    sb.cleanup();
  });

  it("builds the index for a fixture project, then reports its counts", async () => {
    const built = await runIndex({ rebuild: false, status: false }, sb.workspace, dbPath, []);
    expect(built).toMatchObject({ status: "ok", action: "index", rebuilt: false, dbPath });
    expect(existsSync(dbPath)).toBe(true);

    const status = await runIndex({ rebuild: false, status: true }, sb.workspace, dbPath, []);
    expect(status).toMatchObject({ status: "ok", action: "status", exists: true });
    if (status.status !== "ok" || status.action !== "status") throw new Error("expected status");
    expect(status.files).toBeGreaterThanOrEqual(1);
    expect(status.symbols).toBeGreaterThanOrEqual(3);
    expect(formatIndex(status)).toContain("symbols:");
  });

  it("--status does not create a database that was never built", async () => {
    const status = await runIndex({ rebuild: false, status: true }, sb.workspace, dbPath, []);
    expect(status).toMatchObject({ status: "ok", action: "status", exists: false, files: 0 });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("--rebuild replaces a corrupt database, where a plain run fails", async () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "this is not a sqlite database");
    await expect(
      runIndex({ rebuild: false, status: false }, sb.workspace, dbPath, []),
    ).rejects.toThrow();

    const rebuilt = await runIndex({ rebuild: true, status: false }, sb.workspace, dbPath, []);
    expect(rebuilt).toMatchObject({ status: "ok", action: "index", rebuilt: true });
    const status = await runIndex({ rebuild: false, status: true }, sb.workspace, dbPath, []);
    expect(status).toMatchObject({ exists: true });
  });

  it("removeIndexFiles deletes the database and its -wal and -shm sidecars", () => {
    mkdirSync(dirname(dbPath), { recursive: true });
    writeFileSync(dbPath, "db");
    writeFileSync(`${dbPath}-wal`, "wal");
    writeFileSync(`${dbPath}-shm`, "shm");
    removeIndexFiles(dbPath);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    // Missing files are fine.
    expect(() => removeIndexFiles(dbPath)).not.toThrow();
  });

  it("runs from the CLI with --status and JSON output", async () => {
    const { code, lines } = await captureLog(() =>
      run(parseGlobalArgs(["-C", sb.workspace, "--output-format", "json", "index", "--status"])),
    );
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      status: "ok",
      action: "status",
      exists: false,
    });
  });

  it("returns a usage error with exit 1 for a bad flag combination", async () => {
    const { code, lines } = await captureLog(() =>
      run(
        parseGlobalArgs([
          "-C",
          sb.workspace,
          "--output-format",
          "json",
          "index",
          "--status",
          "--rebuild",
        ]),
      ),
    );
    expect(code).toBe(1);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ status: "error", code: "USAGE" });
  });
});
