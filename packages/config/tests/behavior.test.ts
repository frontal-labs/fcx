import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, resolveConfig } from "../src/index.js";
import { readEnv } from "../src/keys.js";

/** Builds a fixture tree: HOME/config-home, and a repo workspace under it. */
describe("config resolution rules", () => {
  let root: string;
  let configHome: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fcx-config-"));
    configHome = join(root, "config-home");
    repo = join(root, "work", "repo");
    mkdirSync(configHome, { recursive: true });
    mkdirSync(join(repo, ".frontal-code"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (path: string, value: unknown) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  const trust = (...roots: string[]) =>
    write(join(configHome, "trusted-workspaces.json"), { trustedWorkspaces: roots });
  const env = (extra: Record<string, string> = {}) =>
    readEnv({ HOME: root, FRONTAL_CODE_CONFIG_HOME: configHome, ...extra });
  const userSettings = (value: unknown) => write(join(configHome, "settings.json"), value);
  const projectSettings = (value: unknown) =>
    write(join(repo, ".frontal-code", "settings.json"), value);
  const localSettings = (value: unknown) =>
    write(join(repo, ".frontal-code", "settings.local.json"), value);

  it("defaults to prompt when no source sets a mode", () => {
    expect(resolveConfig(repo, {}, env()).permissionMode).toBe("prompt");
  });

  it("takes the lowest mode across user, project and local settings", () => {
    trust(root);
    userSettings({ permissionMode: "danger-full-access" });
    projectSettings({ permissionMode: "workspace-write" });
    localSettings({ permissions: { defaultMode: "read-only" } });
    expect(resolveConfig(repo, {}, env()).permissionMode).toBe("read-only");
  });

  it("does not let a trusted project raise the user's mode, and says so", () => {
    trust(root);
    userSettings({ permissionMode: "read-only" });
    projectSettings({ permissionMode: "danger-full-access" });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.permissionMode).toBe("read-only");
    expect(resolved.warnings.map((w) => w.reason).join(" ")).toMatch(/cannot raise the mode/);
  });

  it("maps Frontal Code mode aliases and rejects unknown labels without widening", () => {
    userSettings({ permissionMode: "acceptEdits" });
    expect(resolveConfig(repo, {}, env()).permissionMode).toBe("workspace-write");

    userSettings({ permissionMode: "permissive" });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.permissionMode).toBe("prompt");
    expect(resolved.warnings).toContainEqual(
      expect.objectContaining({
        key: "permissionMode",
        reason: expect.stringMatching(/permissive/),
      }),
    );
  });

  it("ignores the old RUSTY_CLAUDE_PERMISSION_MODE variable, which Frontal Code does not read", () => {
    const resolved = resolveConfig(
      repo,
      {},
      env({ RUSTY_CLAUDE_PERMISSION_MODE: "danger-full-access" }),
    );
    expect(resolved.permissionMode).toBe("prompt");
  });

  it("applies the CLI flag, but never above the policy ceiling", () => {
    userSettings({ policy: { permissionCeiling: "read-only" } });
    expect(
      resolveConfig(repo, { permissionMode: "danger-full-access" }, env()).permissionMode,
    ).toBe("read-only");
    expect(resolveConfig(repo, { permissionMode: "workspace-write" }, env()).permissionMode).toBe(
      "read-only",
    );
  });

  it("ignores project.json runtime.permission_mode, as Frontal Code does", () => {
    write(join(configHome, "project.json"), { runtime: { permission_mode: "danger-full-access" } });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.permissionMode).toBe("prompt");
    expect(resolved.warnings).toContainEqual(
      expect.objectContaining({ key: "runtime.permission_mode", source: "project.json" }),
    );
  });

  it("reads project and local settings only from the cwd, never from a parent directory", () => {
    trust(root);
    write(join(root, "work", ".frontal-code", "settings.json"), { permissionMode: "read-only" });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.permissionMode).toBe("prompt");
  });

  it("trusts a child workspace when a parent directory is trusted", () => {
    trust(join(root, "work"));
    projectSettings({ hooks: [{ command: "echo" }] });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.trust).toMatchObject({ trusted: true, trustedRoot: join(root, "work") });
    expect(resolved.settings.hooks).toBeDefined();
  });

  it("treats an empty trust file as no trusted workspaces", () => {
    write(join(configHome, "trusted-workspaces.json"), {});
    expect(resolveConfig(repo, {}, env()).trust.trusted).toBe(false);
  });

  it("withholds workspace-controlled keys from untrusted project and local files", () => {
    projectSettings({ hooks: [1], sandbox: { enabled: false } });
    localSettings({ permissions: { defaultMode: "danger-full-access" } });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.settings.hooks).toBeUndefined();
    expect(resolved.settings.sandbox).toBeUndefined();
    expect(resolved.permissionMode).toBe("prompt");
    expect(resolved.warnings.map((w) => w.key)).toEqual(
      expect.arrayContaining(["hooks", "sandbox", "permissions.defaultMode"]),
    );
  });

  it("drops allow rules from project and local files even in a trusted workspace", () => {
    trust(root);
    projectSettings({ permissions: { allow: ["Bash(rm:*)"], deny: ["WebFetch"] } });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.settings.permissions).toEqual({ deny: ["WebFetch"] });
    expect(resolved.warnings).toContainEqual(
      expect.objectContaining({
        key: "permissions.allow",
        source: join(repo, ".frontal-code", "settings.json"),
      }),
    );
  });

  it("intersects provider allow-lists across sources and unions deny lists", () => {
    userSettings({ policy: { allowedProviders: ["ggml", "openai"], deny: ["Bash"] } });
    trust(root);
    projectSettings({ policy: { allowedProviders: ["ggml"], deny: ["WebFetch"] } });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.policy.allowedProviders).toEqual(["ggml"]);
    expect(resolved.policy.deny.sort()).toEqual(["Bash", "WebFetch"]);
  });

  it("throws a ConfigError on malformed settings instead of silently ignoring them", () => {
    write(join(configHome, "settings.json"), "{ not json");
    expect(() => resolveConfig(repo, {}, env())).toThrow(ConfigError);
  });

  it("throws a ConfigError when trustedWorkspaces is not a list of strings", () => {
    write(join(configHome, "trusted-workspaces.json"), { trustedWorkspaces: [1] });
    expect(() => resolveConfig(repo, {}, env())).toThrow(/trustedWorkspaces/);
  });

  it("resolves cache and log directories from env, then project.json, then the config home", () => {
    expect(resolveConfig(repo, {}, env()).paths).toEqual({
      cacheDir: join(configHome, "cache"),
      logsDir: join(configHome, "logs"),
    });
    expect(
      resolveConfig(repo, {}, env({ FRONTAL_CODE_CACHE_DIR: "/var/cache/fcx" })).paths.cacheDir,
    ).toBe("/var/cache/fcx");
  });

  it("does not let a settings file pollute Object.prototype", () => {
    userSettings(
      '{"__proto__": {"polluted": "yes"}, "permissions": {"constructor": {"prototype": {"x": 1}}}}',
    );
    const resolved = resolveConfig(repo, {}, env());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.prototype).not.toHaveProperty("x");
    expect(Object.hasOwn(resolved.settings, "__proto__")).toBe(false);
  });

  it("caps a project mode at the default when the user sets none", () => {
    trust(root);
    projectSettings({ permissionMode: "danger-full-access" });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.permissionMode).toBe("prompt");
    expect(resolved.warnings).toContainEqual(expect.objectContaining({ key: "permissionMode" }));
  });

  it("unions project deny rules with the user's instead of replacing them", () => {
    trust(root);
    userSettings({ permissions: { deny: ["Bash(rm:*)"] } });
    projectSettings({ permissions: { deny: ["WebFetch"] } });
    const resolved = resolveConfig(repo, {}, env());
    expect([...(resolved.settings.permissions?.deny ?? [])].sort()).toEqual([
      "Bash(rm:*)",
      "WebFetch",
    ]);
  });

  it("ignores a repo-controlled config/project.json in an untrusted workspace", () => {
    write(join(repo, "Cargo.toml"), "[package]\n");
    write(join(repo, "config", "project.json"), { paths: { cache_dir: join(root, "evil-cache") } });
    const resolved = resolveConfig(repo, {}, env());
    expect(resolved.paths.cacheDir).toBe(join(configHome, "cache"));
  });

  it("ignores a non-string path override instead of crashing", () => {
    write(join(configHome, "project.json"), { paths: { cache_dir: 5 } });
    expect(resolveConfig(repo, {}, env()).paths.cacheDir).toBe(join(configHome, "cache"));
  });
});
