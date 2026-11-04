import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadEntry, entryState, modelsDir } from "../src/index.js";
import type { ModelRegistryEntry } from "../src/types.js";

const BODY_A = "aaaaaaaaaa"; // 10 bytes
const BODY_B = "bbbbbbbbbbbbbbbbbbbb"; // 20 bytes

const entry: ModelRegistryEntry = {
  id: "toy",
  ctx: 512,
  kind: "generation",
  tier: "S",
  license: "MIT",
  files: [
    { name: "a.gguf", url: "https://example.test/a", bytes: BODY_A.length },
    { name: "b.gguf", url: "https://example.test/b", bytes: BODY_B.length },
  ],
};

const fakeFetch = (bodies: Record<string, string>): typeof fetch =>
  (async (url: string | URL | Request) => {
    const key = String(url).endsWith("/a") ? "a" : "b";
    return new Response(bodies[key] ?? "", { status: bodies[key] === undefined ? 404 : 200 });
  }) as typeof fetch;

describe("model downloads", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fcx-models-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reports missing, then installed after a download", async () => {
    expect(await entryState(dir, entry)).toBe("missing");
    const result = await downloadEntry(dir, entry, undefined, fakeFetch({ a: BODY_A, b: BODY_B }));
    expect(result).toEqual({ downloaded: ["a.gguf", "b.gguf"], skipped: [] });
    expect(readFileSync(join(dir, "b.gguf"), "utf8")).toBe(BODY_B);
    expect(await entryState(dir, entry)).toBe("installed");
  });

  it("skips files that are already installed at their exact size", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.gguf"), BODY_A);
    const result = await downloadEntry(dir, entry, undefined, fakeFetch({ b: BODY_B }));
    expect(result).toEqual({ downloaded: ["b.gguf"], skipped: ["a.gguf"] });
  });

  it("refuses a file whose size does not match, and leaves no installed file behind", async () => {
    await expect(
      downloadEntry(dir, entry, undefined, fakeFetch({ a: "short", b: BODY_B })),
    ).rejects.toThrow("a.gguf is 5 bytes, expected 10");
    expect(await entryState(dir, entry)).not.toBe("installed");
  });

  it("reports an HTTP failure", async () => {
    await expect(downloadEntry(dir, entry, undefined, fakeFetch({}))).rejects.toThrow("HTTP 404");
  });

  it("refuses an entry without files", async () => {
    await expect(downloadEntry(dir, { ...entry, files: undefined })).rejects.toThrow(
      "not a downloadable model",
    );
  });
});

describe("modelsDir", () => {
  it("uses FCX_MODELS_DIR when it is set", () => {
    expect(modelsDir({ FCX_MODELS_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });

  it("defaults to the models folder of this repository", () => {
    expect(modelsDir({})).toMatch(/\/models$/);
  });
});
