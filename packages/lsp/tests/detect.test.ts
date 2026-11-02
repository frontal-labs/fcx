import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanguageServerPool, detectServers, languageForFile } from "../src/index.js";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fcx-lsp-detect-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("detectServers", () => {
  it("reports every language, and hides servers when PATH is empty", async () => {
    const servers = await detectServers(root, { pathEnv: "" });
    expect(servers.map((s) => s.language).sort()).toEqual(["go", "python", "rust", "typescript"]);
    const go = servers.find((s) => s.language === "go");
    const python = servers.find((s) => s.language === "python");
    const rust = servers.find((s) => s.language === "rust");
    expect(go?.available).toBe(false);
    expect(python?.available).toBe(false);
    expect(rust?.available).toBe(false);
    if (go?.available === false) expect(go.reason).toMatch(/gopls/);
  });

  it("uses the repo's typescript-language-server for an untrusted workspace", async () => {
    const servers = await detectServers(root, { pathEnv: "" });
    const ts = servers.find((s) => s.language === "typescript");
    expect(ts?.available).toBe(true);
    if (ts?.available) {
      expect(ts.source).toBe("repo");
      expect(ts.command.args).toEqual(["--stdio"]);
      expect(ts.command.initializationOptions).toMatchObject({
        tsserver: { path: expect.stringContaining("typescript") },
      });
    }
  });

  it("ignores a workspace node_modules binary unless the workspace is trusted", async () => {
    const ws = await mkdtemp(join(root, "ws-"));
    const bin = join(ws, "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    const fake = join(bin, "typescript-language-server");
    await writeFile(fake, "#!/bin/sh\nexit 0\n");
    await chmod(fake, 0o755);

    const untrusted = (await detectServers(ws, { pathEnv: "" })).find(
      (s) => s.language === "typescript",
    );
    expect(untrusted?.available && untrusted.source).toBe("repo");

    const trusted = (await detectServers(ws, { pathEnv: "", trustWorkspace: true })).find(
      (s) => s.language === "typescript",
    );
    expect(trusted?.available && trusted.source).toBe("workspace");
  });

  it("rejects a relative workspace path", async () => {
    await expect(detectServers("relative/dir")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("languageForFile", () => {
  it("maps extensions to languages and returns undefined for others", () => {
    expect(languageForFile("/a/b.tsx")).toBe("typescript");
    expect(languageForFile("/a/b.rs")).toBe("rust");
    expect(languageForFile("/a/b.go")).toBe("go");
    expect(languageForFile("/a/b.pyi")).toBe("python");
    expect(languageForFile("/a/README.md")).toBeUndefined();
  });
});

describe("unavailable languages", () => {
  it("returns source unavailable with a reason for a language without a server", async () => {
    const pool = new LanguageServerPool(root, { detect: { pathEnv: "" } });
    try {
      const go = await pool.diagnostics(
        join(root, "main.go"),
        new Map([[join(root, "main.go"), "package main"]]),
      );
      expect(go).toMatchObject({ source: "unavailable", language: "go" });
      if (go.source === "unavailable") expect(go.reason).toMatch(/gopls/);

      const py = await pool.rename(join(root, "m.py"), 1, 1, "x");
      expect(py).toMatchObject({ source: "unavailable", language: "python" });

      const def = await pool.definition(join(root, "m.py"), 1, 1);
      expect(def.source).toBe("unavailable");

      const md = await pool.diagnostics(join(root, "NOTES.md"));
      expect(md).toMatchObject({ source: "unavailable", language: null });
    } finally {
      await pool.shutdown();
    }
  });

  it("returns unavailable without starting any process", async () => {
    const pool = new LanguageServerPool(root, { detect: { pathEnv: "" } });
    const servers = await pool.servers();
    expect(
      servers
        .filter((s) => !s.available)
        .map((s) => s.language)
        .sort(),
    ).toEqual(["go", "python", "rust"]);
    await pool.shutdown();
  });
});
