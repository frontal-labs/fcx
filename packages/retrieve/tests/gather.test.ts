import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Checker, createTsChecker } from "@fcx/verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherFixContext, renderContext } from "../src/index.js";

describe("gatherFixContext", () => {
  let ws: string;
  let checker: Checker | undefined;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-retrieve-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    writeFileSync(
      join(ws, "src", "helper.ts"),
      "export function helper(n: number): number {\n  return n + 1;\n}\n",
    );
    writeFileSync(
      join(ws, "src", "main.ts"),
      'import { helper } from "./helper";\n\nexport function run(): string {\n  return helper(1);\n}\n',
    );
  });

  afterEach(() => {
    checker?.dispose();
    checker = undefined;
    rmSync(ws, { recursive: true, force: true });
  });

  it("includes the enclosing function and the declaration of a helper it calls", () => {
    const file = join(ws, "src", "main.ts");
    checker = createTsChecker(ws, file);
    const context = gatherFixContext({ checker, workspace: ws, file, line: 4, column: 10 });

    expect(context.enclosing?.text).toContain("export function run(): string");
    expect(context.enclosing?.startLine).toBe(3);
    const names = context.definitions.map((d) => d.why);
    expect(names).toContain("definition of helper");
    const helper = context.definitions.find((d) => d.why === "definition of helper");
    expect(helper?.file).toBe(join("src", "helper.ts"));
    expect(helper?.text).toContain("export function helper");
  });

  it("respects the character budget, keeping the enclosing block", () => {
    const file = join(ws, "src", "main.ts");
    checker = createTsChecker(ws, file);
    const context = gatherFixContext({
      checker,
      workspace: ws,
      file,
      line: 4,
      column: 10,
      budgetChars: 1,
    });
    expect(context.enclosing).not.toBeNull();
    expect(context.definitions).toHaveLength(0);
  });

  it("returns no context for a file the checker does not know", () => {
    const file = join(ws, "src", "main.ts");
    checker = createTsChecker(ws, file);
    const context = gatherFixContext({
      checker,
      workspace: ws,
      file: join(ws, "src", "missing.ts"),
      line: 1,
      column: 1,
    });
    expect(context).toEqual({ enclosing: null, definitions: [] });
  });
});

describe("renderContext", () => {
  it("renders each block with its location and reason", () => {
    const text = renderContext({
      enclosing: { file: "a.ts", startLine: 1, endLine: 2, text: "x", why: "enclosing scope" },
      definitions: [{ file: "b.ts", startLine: 5, endLine: 5, text: "y", why: "definition of y" }],
    });
    expect(text).toBe("--- a.ts:1-2 (enclosing scope)\nx\n\n--- b.ts:5-5 (definition of y)\ny");
  });

  it("renders nothing when there is no context", () => {
    expect(renderContext({ enclosing: null, definitions: [] })).toBe("");
  });
});
