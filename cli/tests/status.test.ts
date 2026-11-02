import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctor } from "../src/commands/doctor.js";
import { status } from "../src/commands/status.js";

const CONFIG_KEYS = [
  "FRONTAL_CODE_CONFIG_HOME",
  "FRONTAL_CODE_HOME",
  "RUSTY_CLAUDE_PERMISSION_MODE",
];

describe("status and doctor", () => {
  let root: string;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-cli-"));
    mkdirSync(join(root, ".git"));
    saved = Object.fromEntries(CONFIG_KEYS.map((k) => [k, process.env[k]]));
    for (const k of CONFIG_KEYS) Reflect.deleteProperty(process.env, k);
    process.env.FRONTAL_CODE_CONFIG_HOME = join(root, "config-home");
    mkdirSync(join(root, "config-home"));
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("reports the default permission mode and an untrusted workspace", () => {
    const report = status(root);
    expect(report.permissionMode).toBe("prompt");
    expect(report.trust.trusted).toBe(false);
    expect(report.status).toBe("ok");
  });

  it("lets the CLI flag set the permission mode", () => {
    expect(status(root, "read-only").permissionMode).toBe("read-only");
  });

  it("fails doctor when policy excludes the ggml provider", async () => {
    writeFileSync(
      join(root, "config-home", "settings.json"),
      JSON.stringify({ policy: { allowedProviders: ["openai"] } }),
    );
    const report = await doctor(root);
    const check = report.checks.find((c) => c.name === "policy-ggml-provider");
    expect(check?.status).toBe("fail");
    expect(report.status).toBe("fail");
  });

  it("does not import the model package from status or the --version path", async () => {
    // Static guard for plan §15.2: the status and doctor code must not import ggml-node eagerly.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/from "ggml-node"|from "@fcx\/model"/);
  });
});
