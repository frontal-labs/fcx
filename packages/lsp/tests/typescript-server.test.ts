import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanguageServerPool, LspError, detectServers } from "../src/index.js";

// Real typescript-language-server round trips on a temp project.
// One pool is shared by the whole file so the server starts once.

const ORIGINAL = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export const total: number = add(1, 2);",
  "",
].join("\n");

const BROKEN = ORIGINAL.replace("add(1, 2)", '"oops"');

let root: string;
let file: string;
let pool: LanguageServerPool;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "fcx-lsp-ts-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "NodeNext" } }),
  );
  file = join(root, "src", "math.ts");
  await writeFile(file, ORIGINAL);
  pool = new LanguageServerPool(root, { diagnosticsTimeoutMs: 20_000, requestTimeoutMs: 20_000 });
}, 30_000);

afterAll(async () => {
  await pool.shutdown();
  await rm(root, { recursive: true, force: true });
});

describe("typescript-language-server round trip", () => {
  it("reports a type error from a candidate overlay", async () => {
    const result = await pool.diagnostics(file, new Map([[file, BROKEN]]));
    expect(result.source).toBe("language-server");
    if (result.source !== "language-server") return;
    const errors = result.diagnostics.filter((d) => d.file === file);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.severity).toBe("error");
    expect(errors[0]?.range.start.line).toBe(4);
  }, 30_000);

  it("reports the error an overlay introduces", async () => {
    const broke = await pool.diagnostics(file, new Map([[file, BROKEN]]));
    expect(broke.source === "language-server" && broke.diagnostics.length).toBeGreaterThan(0);
  }, 30_000);

  it("reports a fixed overlay as clean only when the server publishes an empty set for that version", async () => {
    await pool.diagnostics(file, new Map([[file, BROKEN]]));
    const fixed = await pool.diagnostics(file, new Map([[file, ORIGINAL]]));
    expect(fixed).toEqual({ source: "language-server", language: "typescript", diagnostics: [] });
  }, 30_000);

  it("leaves the file on disk unchanged after overlay checks", async () => {
    const before = await readFile(file, "utf8");
    const mtimeBefore = (await stat(file)).mtimeMs;
    await pool.diagnostics(file, new Map([[file, BROKEN]]));
    expect(await readFile(file, "utf8")).toBe(before);
    expect((await stat(file)).mtimeMs).toBe(mtimeBefore);
    expect(before).toBe(ORIGINAL);
  }, 30_000);

  it("reports the definition of a call", async () => {
    // Column 30 is the `add` in `add(1, 2)`.
    const result = await pool.definition(file, 4, 30);
    expect(result.source).toBe("language-server");
    if (result.source !== "language-server") return;
    expect(result.locations[0]?.file).toBe(file);
    expect(result.locations[0]?.range.start.line).toBe(1);
  }, 30_000);

  it("returns a rename WorkspaceEdit without writing to disk", async () => {
    const before = await readFile(file, "utf8");
    // Column 17 is the `add` in the declaration.
    const result = await pool.rename(file, 1, 17, "sum");
    expect(result.source).toBe("language-server");
    if (result.source !== "language-server") return;
    const edits = result.edit.files.find((f) => f.file === file)?.edits ?? [];
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(edits.every((e) => e.newText === "sum")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(before);
  }, 30_000);

  it("keeps working after several overlays and reverts", async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await pool.diagnostics(file, new Map([[file, BROKEN]]));
      expect(result.source).toBe("language-server");
    }
    const clean = await pool.diagnostics(file, new Map([[file, ORIGINAL]]));
    expect(
      clean.source === "language-server" && clean.diagnostics.filter((d) => d.severity === "error"),
    ).toEqual([]);
  }, 60_000);

  it("rejects overlays whose language differs from the file", async () => {
    await expect(
      pool.diagnostics(file, new Map([[join(root, "notes.md"), "x"]])),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects relative paths and bad positions with INVALID_ARGUMENT", async () => {
    await expect(pool.diagnostics("src/math.ts")).rejects.toBeInstanceOf(LspError);
    await expect(pool.definition(file, 0, 1)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("detects the typescript server from the repo when the workspace is untrusted", async () => {
    const servers = await detectServers(root);
    const ts = servers.find((s) => s.language === "typescript");
    expect(ts?.available).toBe(true);
    if (ts?.available) expect(ts.source).toBe("repo");
  });
});
