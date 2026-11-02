import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.js";
import { type Sandbox, makeSandbox } from "./support.js";

/** Puts a language server binary and a typescript package inside the workspace's own node_modules. */
function installWorkspaceServer(workspace: string): void {
  const bin = join(workspace, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const server = join(bin, "typescript-language-server");
  writeFileSync(server, "#!/bin/sh\nexit 0\n");
  chmodSync(server, 0o755);
  const tsserver = join(workspace, "node_modules", "typescript", "lib");
  mkdirSync(tsserver, { recursive: true });
  writeFileSync(join(tsserver, "tsserver.js"), "// stub\n");
}

describe("doctor language-server trust line", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-doctor-");
    installWorkspaceServer(sb.workspace);
  });

  afterEach(() => {
    sb.cleanup();
  });

  const lspCheck = async () => {
    const report = await doctor(sb.workspace);
    const check = report.checks.find((c) => c.name === "language-servers");
    if (!check) throw new Error("no language-servers check");
    return check;
  };

  it("warns when a workspace server exists but the workspace is untrusted", async () => {
    const check = await lspCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toMatch(/typescript.*untrusted|untrusted.*typescript/);
    expect(check.detail).toContain("frontal-code trust");
  });

  it("uses the workspace server once the workspace is trusted", async () => {
    writeFileSync(
      join(sb.configHome, "trusted-workspaces.json"),
      JSON.stringify({ trustedWorkspaces: [sb.workspace] }),
    );
    const check = await lspCheck();
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("typescript (workspace)");
  });
});
