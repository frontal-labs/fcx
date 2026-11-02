import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectServers } from "../src/servers.js";

describe("workspace binaries are not trusted by default", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-lsp-trust-"));
    const bin = join(ws, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "typescript-language-server");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const typescriptEntry = async (trustWorkspace: boolean) => {
    const found = await detectServers(ws, { pathEnv: "", trustWorkspace });
    return found.find((s) => s.language === "typescript");
  };

  it("ignores a repo-controlled server binary when the workspace is not trusted", async () => {
    const entry = await typescriptEntry(false);
    expect(entry?.available === true && entry.source === "workspace").toBe(false);
    const binaryPath = entry && "binaryPath" in entry ? entry.binaryPath : undefined;
    expect(binaryPath?.startsWith(ws)).not.toBe(true);
  });

  it("uses the workspace binary only when the workspace is trusted", async () => {
    const entry = await typescriptEntry(true);
    expect(entry).toMatchObject({ available: true, source: "workspace" });
  });

  it("refuses a trusted workspace binary that is a symlink leaving the workspace", async () => {
    const outside = mkdtempSync(join(tmpdir(), "fcx-lsp-outside-"));
    try {
      const target = join(outside, "evil");
      writeFileSync(target, "#!/bin/sh\nexit 0\n");
      chmodSync(target, 0o755);
      const link = join(ws, "node_modules", ".bin", "typescript-language-server");
      rmSync(link);
      symlinkSync(target, link);
      const entry = await typescriptEntry(true);
      expect(entry?.available === true && entry.source === "workspace").toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
