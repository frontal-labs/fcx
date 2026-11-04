import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalArgs } from "../src/args.js";
import { runInitCommand } from "../src/commands/init.js";

const args = (rest: string[] = []): GlobalArgs => ({
  command: "init",
  rest,
  outputFormat: "json",
  permissionMode: undefined,
  cwd: undefined,
  dryRun: false,
  noEscalate: false,
  help: false,
  version: false,
});

describe("fcx init", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-init-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates the project folder with a README and settings", () => {
    expect(runInitCommand(args(), root)).toBe(0);
    const settings = JSON.parse(readFileSync(join(root, ".frontal-code", "settings.json"), "utf8"));
    expect(settings.model).toBe("ggml/auto");
    expect(readFileSync(join(root, ".frontal-code", "README.md"), "utf8")).toContain("fcx trust");
  });

  it("never overwrites a file that already exists", () => {
    runInitCommand(args(), root);
    writeFileSync(join(root, ".frontal-code", "settings.json"), '{"mine": true}\n');
    expect(runInitCommand(args(), root)).toBe(0);
    expect(readFileSync(join(root, ".frontal-code", "settings.json"), "utf8")).toBe(
      '{"mine": true}\n',
    );
  });

  it("adds the local settings file to an existing .gitignore once", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/");
    runInitCommand(args(), root);
    runInitCommand(args(), root);
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(
      ignore.split("\n").filter((l) => l === ".frontal-code/settings.local.json"),
    ).toHaveLength(1);
    expect(ignore.startsWith("node_modules/\n")).toBe(true);
  });

  it("fails for a path that is not a directory", () => {
    expect(runInitCommand(args([join(root, "missing")]), root)).toBe(1);
  });
});
