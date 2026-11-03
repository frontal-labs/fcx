import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "@fcx/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalArgs } from "../src/args.js";
import { runTrustCommand } from "../src/commands/trust.js";
import { resolveFcxConfig } from "../src/lib/config.js";

const args = (rest: string[] = [], outputFormat: "text" | "json" = "json"): GlobalArgs => ({
  command: "trust",
  rest,
  outputFormat,
  permissionMode: undefined,
  cwd: undefined,
  dryRun: false,
  noEscalate: false,
  help: false,
  version: false,
});

describe("fcx trust", () => {
  let root: string;
  let configHome: string;
  let workspace: string;
  let savedConfigHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-trust-"));
    configHome = join(root, "config");
    workspace = join(root, "repo");
    mkdirSync(join(workspace, ".frontal-code"), { recursive: true });
    writeFileSync(
      join(workspace, ".frontal-code", "settings.json"),
      JSON.stringify({ plugins: [] }),
    );
    savedConfigHome = process.env.FRONTAL_CODE_CONFIG_HOME;
    process.env.FRONTAL_CODE_CONFIG_HOME = configHome;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedConfigHome === undefined)
      Reflect.deleteProperty(process.env, "FRONTAL_CODE_CONFIG_HOME");
    else process.env.FRONTAL_CODE_CONFIG_HOME = savedConfigHome;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes the workspace to the shared trust list and makes resolveConfig trust it", () => {
    expect(resolveConfig(workspace).trust.trusted).toBe(false);

    expect(runTrustCommand(args([workspace]), root)).toBe(0);

    const list = JSON.parse(readFileSync(join(configHome, "trusted-workspaces.json"), "utf-8"));
    expect(list.trustedWorkspaces).toHaveLength(1);
    expect(resolveConfig(workspace).trust.trusted).toBe(true);
  });

  it("names fcx trust in the warnings fcx prints, and Frontal Code's command stays in the shared config", () => {
    const fcx = resolveFcxConfig(workspace).warnings.map((w) => w.reason);
    expect(fcx.length).toBeGreaterThan(0);
    for (const reason of fcx) expect(reason).toContain("run `fcx trust`");
    const shared = resolveConfig(workspace).warnings.map((w) => w.reason);
    for (const reason of shared) expect(reason).toContain("run `frontal-code trust`");
  });

  it("defaults to the current directory when no path is given", () => {
    expect(runTrustCommand(args(), workspace)).toBe(0);
    expect(resolveConfig(workspace).trust.trusted).toBe(true);
  });

  it("does not add a workspace twice", () => {
    runTrustCommand(args([workspace]), root);
    runTrustCommand(args([workspace]), root);
    const list = JSON.parse(readFileSync(join(configHome, "trusted-workspaces.json"), "utf-8"));
    expect(list.trustedWorkspaces).toHaveLength(1);
  });

  it("fails for a path that is not a directory and writes nothing", () => {
    expect(runTrustCommand(args([join(root, "missing")]), root)).toBe(1);
    expect(() => readFileSync(join(configHome, "trusted-workspaces.json"))).toThrow();
  });
});
