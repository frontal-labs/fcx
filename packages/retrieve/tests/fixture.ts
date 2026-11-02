import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Files of the small fixture project. Line numbers matter to the tests; keep them stable. */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify({
    name: "fixture-app",
    version: "0.0.0",
    dependencies: { zod: "^3.0.0" },
    devDependencies: { vitest: "^2.0.0" },
  }),
  "src/config.ts": [
    "export interface Config {",
    "  name: string;",
    "  retries: number;",
    "}",
    "",
    "export function parseConfig(raw: string): Config {",
    '  const parts = raw.split(":");',
    '  return { name: parts[0] ?? "", retries: Number(parts[1] ?? 0) };',
    "}",
    "",
  ].join("\n"),
  "src/loader.ts": [
    'import { type Config, parseConfig } from "./config";',
    "",
    "export function readRaw(path: string): string {",
    "  return path;",
    "}",
    "",
    "export function loadConfig(path: string): Config {",
    "  return parseConfig(readRaw(path));",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": [
    'import { loadConfig } from "./loader";',
    "",
    "export function startApp(path: string): string {",
    "  const config = loadConfig(path);",
    "  return `${config.name} retries ${config.retries}`;",
    "}",
    "",
    "export function stopApp(path: string): void {",
    "  loadConfig(path);",
    "}",
    "",
  ].join("\n"),
  "tests/config.test.ts": [
    'import { expect, test } from "vitest";',
    'import { parseConfig } from "../src/config";',
    "",
    'test("parseConfig splits name and retries", () => {',
    '  expect(parseConfig("svc:3").retries).toBe(3);',
    "});",
    "",
  ].join("\n"),
};

/** Creates the fixture project in a fresh temp directory and returns its absolute path. */
export function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "fcx-retrieve-fixture-"));
  for (const [path, text] of Object.entries(FIXTURE_FILES)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text);
  }
  return root;
}

/**
 * A deterministic stand-in for an embedding model: each character votes for one of `dimensions`
 * buckets. Texts that share characters get similar vectors, which is enough for ranking tests.
 */
export function fakeEmbedder(dimensions = 8): {
  model: string;
  dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
} {
  return {
    model: "fake-embed",
    dimensions,
    embed(texts) {
      return Promise.resolve(
        texts.map((text) => {
          const vector = new Float32Array(dimensions);
          for (let i = 0; i < text.length; i += 1) {
            vector[text.charCodeAt(i) % dimensions] += 1;
          }
          return vector;
        }),
      );
    },
  };
}
