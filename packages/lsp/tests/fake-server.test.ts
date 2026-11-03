import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LanguageServerPool, LspError, type ServerCommand } from "../src/index.js";

// Uses tests/fixtures/fake-lsp-server.mjs, a small LSP server, so timeouts, crashes and
// shutdown can be tested without depending on a real server's timing.

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp-server.mjs");

let root: string;
let file: string;
let pool: LanguageServerPool | undefined;

function fakeCommand(env: Record<string, string>): ServerCommand {
  return { command: process.execPath, args: [FAKE], env };
}

function makePool(
  env: Record<string, string>,
  options: Partial<ConstructorParameters<typeof LanguageServerPool>[1]> = {},
): LanguageServerPool {
  pool = new LanguageServerPool(root, {
    servers: { typescript: fakeCommand(env) },
    diagnosticsTimeoutMs: 400,
    requestTimeoutMs: 2000,
    initializeTimeoutMs: 5000,
    settleMs: 20,
    silentCleanMs: 50,
    ...options,
  });
  return pool;
}

async function processGone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "fcx-lsp-fake-"));
  file = join(root, "a.ts");
  await writeFile(file, "export const a = 1;\n");
});

afterEach(async () => {
  await pool?.shutdown();
  pool = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("error class", () => {
  it("carries a stable code and a name", () => {
    const error = new LspError("TIMEOUT", "slow", { language: "typescript" });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("TIMEOUT");
    expect(error.language).toBe("typescript");
    expect(error.name).toBe("LspError");
  });
});

describe("timeouts", () => {
  it("rejects an overlay check that gets no diagnostics with code TIMEOUT", async () => {
    const p = makePool({ FAKE_LSP_SILENT: "1" }, { diagnosticsTimeoutMs: 300 });
    const started = Date.now();
    await expect(
      p.diagnostics(file, new Map([[file, "const x: number = 'a';"]])),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15_000);
});

describe("shutdown", () => {
  it("waits for the type errors that follow an empty syntax pass", async () => {
    // The fake publishes an empty set first and the error 300 ms later. The pool's empty-publish
    // window (500 ms by default) is longer than that gap, so the error is seen.
    makePool({ FAKE_LSP_SPLIT: "1" });
    await writeFile(file, "export const a = 1;\n");
    const result = await pool?.diagnostics(file, new Map([[file, "const x = ERROR;\n"]]));
    expect(result).toMatchObject({ source: "language-server" });
    if (result?.source !== "language-server") return;
    expect(result.diagnostics.map((d) => d.message)).toEqual(["fake error"]);
  });

  it("reports an empty result when the server stays silent after an empty state", async () => {
    // First check: the server publishes an empty set for the clean text. Second check: the same text
    // again, and the server publishes nothing. The pool reports the empty state after silentCleanMs.
    makePool(
      { FAKE_LSP_SILENT_AFTER_FIRST: "1" },
      { diagnosticsTimeoutMs: 3000, emptySettleMs: 20, silentCleanMs: 50 },
    );
    const clean = "export const a = 1;\n";
    await pool?.diagnostics(file, new Map([[file, clean]]));
    const second = await pool?.diagnostics(file, new Map([[file, clean]]));
    expect(second).toEqual({ source: "language-server", language: "typescript", diagnostics: [] });
  });

  it("terminates the server process", async () => {
    const pidFile = join(root, "pid.txt");
    const p = makePool({ FAKE_LSP_PID_FILE: pidFile });
    const result = await p.diagnostics(file, new Map([[file, "export const a = 1;\n"]]));
    expect(result.source).toBe("language-server");
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    expect(process.kill(pid, 0)).toBe(true);

    await p.shutdown();
    expect(await processGone(pid, 3000)).toBe(true);
  }, 20_000);

  it("refuses calls after shutdown with POOL_CLOSED", async () => {
    const p = makePool({});
    await p.shutdown();
    await expect(p.diagnostics(file)).rejects.toMatchObject({ code: "POOL_CLOSED" });
  });
});

describe("crash and restart", () => {
  it("reports a crash, restarts once, and then answers", async () => {
    const exits: { willRestart: boolean; code: number | null }[] = [];
    const p = makePool(
      { FAKE_LSP_CRASH: "once", FAKE_LSP_MARKER: join(root, "marker") },
      { onServerExit: (info) => exits.push({ willRestart: info.willRestart, code: info.code }) },
    );

    await expect(
      p.diagnostics(file, new Map([[file, "export const a = 2;\n"]])),
    ).rejects.toMatchObject({
      code: "CRASHED",
    });
    expect(exits).toEqual([{ willRestart: true, code: 3 }]);

    const second = await p.diagnostics(file, new Map([[file, "export const a = 2;\n"]]));
    expect(second.source).toBe("language-server");
  }, 20_000);

  it("fails with a clear error after the restart is used up", async () => {
    const exits: boolean[] = [];
    const p = makePool(
      { FAKE_LSP_CRASH: "always" },
      { onServerExit: (info) => exits.push(info.willRestart) },
    );

    await expect(p.diagnostics(file, new Map([[file, "x"]]))).rejects.toMatchObject({
      code: "CRASHED",
    });
    await expect(p.diagnostics(file, new Map([[file, "x"]]))).rejects.toMatchObject({
      code: "CRASHED",
    });
    const third = p.diagnostics(file, new Map([[file, "x"]]));
    await expect(third).rejects.toBeInstanceOf(LspError);
    await expect(third).rejects.toThrow(/restart limit/);
    expect(exits).toEqual([true, false]);
  }, 20_000);
});

describe("start failure", () => {
  it("reports the language as unavailable when the binary cannot be spawned", async () => {
    const p = makePool({});
    // Replace the command for this test only.
    await p.shutdown();
    const broken = new LanguageServerPool(root, {
      servers: { typescript: { command: join(root, "no-such-server"), args: [] } },
      initializeTimeoutMs: 2000,
    });
    pool = broken;
    const result = await broken.diagnostics(file, new Map([[file, "x"]]));
    expect(result.source).toBe("unavailable");
    if (result.source !== "unavailable") return;
    expect(result.language).toBe("typescript");
    expect(result.reason).toMatch(/failed to start/);
  }, 15_000);
});
