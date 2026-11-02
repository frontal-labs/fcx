import { describe, expect, it } from "vitest";
import { extractFile } from "../src/extract.js";

const SOURCE = `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

export class Store {
  private items: string[] = [];
  get size(): number {
    return this.items.length;
  }
  load(path: string): void {
    add(1, 2);
    this.reset();
  }
  private reset(): void {}
}

export interface Options {
  retries: number;
}

export type Id = string;

export enum Color {
  Red,
}

export const MAX = 3;

const helper = (x: number) => x * 2;
`;

describe("extractFile symbols", () => {
  const result = extractFile("src/store.ts", SOURCE);
  const byQualified = new Map(result.symbols.map((s) => [s.qualified, s]));

  it("extracts functions, classes, methods, interfaces, types, enums and consts", () => {
    expect([...byQualified.keys()].sort()).toEqual(
      [
        "Color",
        "Id",
        "MAX",
        "Options",
        "Store",
        "Store.load",
        "Store.reset",
        "Store.size",
        "add",
        "helper",
      ].sort(),
    );
    expect(byQualified.get("add")?.kind).toBe("function");
    expect(byQualified.get("Store")?.kind).toBe("class");
    expect(byQualified.get("Store.load")?.kind).toBe("method");
    expect(byQualified.get("Options")?.kind).toBe("interface");
    expect(byQualified.get("Id")?.kind).toBe("type");
    expect(byQualified.get("Color")?.kind).toBe("enum");
    expect(byQualified.get("MAX")?.kind).toBe("const");
    expect(byQualified.get("helper")?.kind).toBe("function");
  });

  it("records signatures, doc comments, export flags and line ranges", () => {
    const add = byQualified.get("add");
    expect(add).toBeDefined();
    expect(add?.signature).toBe("export function add(a: number, b: number): number");
    expect(add?.doc).toBe("Adds two numbers.");
    expect(add?.exported).toBe(true);
    expect(add?.startLine).toBe(2);
    expect(add?.endLine).toBe(4);

    const helper = byQualified.get("helper");
    expect(helper?.exported).toBe(false);
    expect(helper?.signature).toBe("const helper = (x: number)");

    const reset = byQualified.get("Store.reset");
    expect(reset?.exported).toBe(false);
    expect(byQualified.get("Store.load")?.exported).toBe(true);
  });

  it("puts one chunk per symbol with the qualified name, signature and body", () => {
    const load = byQualified.get("Store.load");
    expect(load?.chunkText).toContain("Store.load");
    expect(load?.chunkText).toContain("load(path: string): void");
    expect(load?.chunkText).toContain("this.reset()");
    expect(load?.tokens).toBeGreaterThan(0);
    expect(load?.tokens).toBeLessThanOrEqual(256);
  });

  it("caps chunk text at 256 tokens", () => {
    const body = Array.from(
      { length: 24 },
      (_, i) => `  ${Array.from({ length: 15 }, (_w, j) => `w${i}x${j}`).join(" ")};`,
    ).join("\n");
    const big = extractFile("big.ts", `export function big() {\n${body}\n}\n`);
    const chunk = big.symbols[0];
    expect(chunk?.tokens).toBe(256);
    expect(chunk?.chunkText.split(/\s+/).length).toBe(256);
  });
});

describe("extractFile imports and calls", () => {
  it("records every import form", () => {
    const result = extractFile(
      "src/app.ts",
      `import def, { a as b, c } from "./lib";\nimport * as ns from "./ns";\nimport "./side";\nexport { z } from "./re";\n`,
    );
    const specs = result.imports.map((i) => i.specifier);
    expect(specs).toEqual(["./lib", "./ns", "./side", "./re"]);
    expect(result.imports[0]?.bindings).toEqual([
      { kind: "default", local: "def" },
      { kind: "named", local: "b", imported: "a" },
      { kind: "named", local: "c", imported: "c" },
    ]);
    expect(result.imports[1]?.bindings).toEqual([{ kind: "namespace", local: "ns" }]);
  });

  it("attributes calls to the enclosing symbol", () => {
    const result = extractFile("src/store.ts", SOURCE);
    const loadIndex = result.symbols.findIndex((s) => s.qualified === "Store.load");
    const calls = result.calls.filter((c) => c.caller === loadIndex);
    expect(calls.map((c) => c.name).sort()).toEqual(["add", "reset"]);
    expect(calls.find((c) => c.name === "reset")?.receiver).toEqual({ kind: "this" });
    expect(calls.find((c) => c.name === "add")?.receiver).toBeUndefined();
  });

  it("records namespace receivers for member calls", () => {
    const result = extractFile(
      "src/a.ts",
      "import * as u from './u';\nexport function f() { u.go(); }\n",
    );
    expect(result.calls).toEqual([
      { caller: 0, name: "go", receiver: { kind: "identifier", name: "u" } },
    ]);
  });
});

describe("extractFile test files", () => {
  const source = `import { add } from "./math";
describe("math", () => {
  describe("add", () => {
    it("adds small numbers", () => {
      expect(add(1, 2)).toBe(3);
    });
  });
  test("keeps zero", () => {
    add(0, 0);
  });
});
`;

  it("creates a test symbol per test case with the describe path as qualified name", () => {
    const result = extractFile("src/math.test.ts", source);
    const tests = result.symbols.filter((s) => s.kind === "test");
    expect(tests.map((t) => t.qualified)).toEqual([
      "math > add > adds small numbers",
      "math > keeps zero",
    ]);
    expect(tests.map((t) => t.name)).toEqual(["adds small numbers", "keeps zero"]);
  });

  it("attributes calls inside a test body to that test symbol", () => {
    const result = extractFile("src/math.test.ts", source);
    const first = result.symbols.findIndex((s) => s.name === "adds small numbers");
    expect(result.calls.filter((c) => c.caller === first).map((c) => c.name)).toContain("add");
  });

  it("does not create test symbols outside test files", () => {
    const result = extractFile("src/math.ts", source);
    expect(result.symbols.some((s) => s.kind === "test")).toBe(false);
  });
});
