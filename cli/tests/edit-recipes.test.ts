import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDocCommand } from "../src/commands/doc.js";
import { runFixTestCommand } from "../src/commands/fix-test.js";
import { runImplementCommand } from "../src/commands/implement.js";
import { runRefactorCommand } from "../src/commands/refactor.js";
import { runRenameCommand } from "../src/commands/rename.js";
import { runTypesCommand } from "../src/commands/types.js";
import { exitCodeFor } from "../src/lib/recipe-runtime.js";
import { recipeEnv, writeProject } from "./recipe-support.js";
import { type Sandbox, makeSandbox, scriptedModel } from "./support.js";

const MATH = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const TEST = [
  'import { add } from "../src/math.js";',
  "",
  'it("adds two numbers", () => {',
  "  const sum: number = add(1, 2);",
  '  if (sum !== 3) throw new Error("expected 3");',
  "});",
  "",
].join("\n");

const STUB = [
  "/** Returns the sum of two numbers. */",
  "export function add(a: number, b: number): number {",
  '  throw new Error("not implemented");',
  "}",
  "",
].join("\n");

const UNANNOTATED = [
  "export const SCALE = 2;",
  "export function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const DOC_SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
].join("\n");

const UTIL = "export function double(n: number): number {\n  return n * 2;\n}\n";
const APP = 'import { double } from "./util.js";\n\nexport const four: number = double(2);\n';

describe("fix-test command", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-fixtest-");
    writeProject(sb.workspace, {
      "src/math.ts": MATH,
      "tests/math.test.ts": TEST,
      // The test runner's globals, so the test file type-checks apart from the bug the recipe fixes.
      "tests/globals.d.ts": "declare function it(name: string, fn: () => void): void;\n",
    });
  });
  afterEach(() => sb.cleanup());

  const input = {
    file: "tests/math.test.ts",
    testName: "adds two numbers",
    failureOutput: "AssertionError: expected 3",
  };

  it("applies a verified edit and reports the undo id", async () => {
    const model = scriptedModel([
      { edits: [{ file: "src/math.ts", search: "return a - b;", replace: "return a + b;" }] },
    ]);
    const report = await runFixTestCommand(recipeEnv(sb, model), input);
    expect(report).toMatchObject({ command: "fix-test", recipe: "fix-test", status: "applied" });
    expect(report.undoId).toBeDefined();
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toContain("return a + b;");
    expect(report.notChecked.join(" ")).toMatch(/test-run/);
    expect(model.prompts[0]).toContain("AssertionError: expected 3");
    expect(exitCodeFor(report.status)).toBe(0);
  });

  it("proposes without writing in read-only mode", async () => {
    const model = scriptedModel([
      { edits: [{ file: "src/math.ts", search: "return a - b;", replace: "return a + b;" }] },
    ]);
    const report = await runFixTestCommand(
      recipeEnv(sb, model, { permissionMode: "read-only" }),
      input,
    );
    expect(report.status).toBe("proposed");
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toBe(MATH);
  });

  it("declines in prompt mode when the user says no", async () => {
    const model = scriptedModel([
      { edits: [{ file: "src/math.ts", search: "return a - b;", replace: "return a + b;" }] },
    ]);
    const report = await runFixTestCommand(
      recipeEnv(sb, model, { permissionMode: "prompt", approve: async () => false }),
      input,
    );
    expect(report.status).toBe("declined");
    expect(exitCodeFor(report.status)).toBe(3);
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toBe(MATH);
  });

  it("reports an unknown test name as invalid input, not a crash", async () => {
    const report = await runFixTestCommand(recipeEnv(sb, scriptedModel([])), {
      file: "tests/math.test.ts",
      testName: "missing",
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("INVALID_INPUT");
    expect(exitCodeFor(report.status)).toBe(1);
  });

  it("abstains with exit 2 when the edit fails the anchor check", async () => {
    const bad = { edits: [{ file: "src/math.ts", search: "not in the file", replace: "x" }] };
    const report = await runFixTestCommand(recipeEnv(sb, scriptedModel([bad])), input);
    expect(report.status).toBe("abstained");
    expect(report.lastError).toBeTruthy();
    expect(exitCodeFor(report.status)).toBe(2);
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toBe(MATH);
  });
});

describe("implement command", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-impl-");
    writeProject(sb.workspace, { "src/math.ts": STUB });
  });
  afterEach(() => sb.cleanup());

  it("writes the body of the stub at the line", async () => {
    const report = await runImplementCommand(
      recipeEnv(sb, scriptedModel([{ body: "return a + b;" }])),
      {
        file: "src/math.ts",
        line: 3,
      },
    );
    expect(report.status).toBe("applied");
    expect(report.replacement).toBe(
      "export function add(a: number, b: number): number {\nreturn a + b;\n}",
    );
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toContain("return a + b;");
  });

  it("abstains with exit 2 when no candidate type-checks", async () => {
    const bad = { body: "return missingHelper(a, b);" };
    const report = await runImplementCommand(recipeEnv(sb, scriptedModel([bad])), {
      file: "src/math.ts",
      line: 3,
    });
    expect(report.status).toBe("abstained");
    expect(exitCodeFor(report.status)).toBe(2);
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toBe(STUB);
  });

  it("reports a line with no function as invalid input", async () => {
    const report = await runImplementCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/math.ts",
      line: 99,
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("INVALID_INPUT");
  });
});

describe("types command", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-types-");
    writeProject(sb.workspace, { "src/math.ts": UNANNOTATED });
  });
  afterEach(() => sb.cleanup());

  it("annotates the named symbol's return type", async () => {
    const model = scriptedModel([
      {
        edits: [
          {
            file: "src/math.ts",
            search: "export function add(a: number, b: number) {",
            replace: "export function add(a: number, b: number): number {",
          },
        ],
      },
    ]);
    const report = await runTypesCommand(recipeEnv(sb, model), {
      file: "src/math.ts",
      symbol: "add",
    });
    expect(report.error, JSON.stringify(report)).toBeUndefined();
    expect(report.status).toBe("applied");
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toContain(
      "function add(a: number, b: number): number {",
    );
  });

  it("reports nothing to annotate without calling the model", async () => {
    writeProject(sb.workspace, { "src/math.ts": "export const typed: number = 1;\n" });
    const model = scriptedModel([]);
    const report = await runTypesCommand(recipeEnv(sb, model), { file: "src/math.ts" });
    expect(report.status).toBe("nothing-to-annotate");
    expect(exitCodeFor(report.status)).toBe(0);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("doc command", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-doc-");
    writeProject(sb.workspace, { "src/math.ts": DOC_SOURCE });
  });
  afterEach(() => sb.cleanup());

  it("inserts the doc comment above the declaration at the line", async () => {
    const report = await runDocCommand(
      recipeEnv(sb, scriptedModel([{ doc: "/** Adds two numbers. */" }])),
      { file: "src/math.ts", line: 1 },
    );
    expect(report.status).toBe("applied");
    expect(report.doc).toBe("/** Adds two numbers. */");
    expect(
      readFileSync(join(sb.workspace, "src/math.ts"), "utf8").startsWith(
        "/** Adds two numbers. */",
      ),
    ).toBe(true);
  });
});

describe("refactor command", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-refactor-");
    writeProject(sb.workspace, { "src/util.ts": UTIL, "src/app.ts": APP });
  });
  afterEach(() => sb.cleanup());

  it("applies a verified refactor of the selected range", async () => {
    const model = scriptedModel([
      { edits: [{ file: "src/util.ts", search: "  return n * 2;", replace: "  return n + n;" }] },
    ]);
    const report = await runRefactorCommand(recipeEnv(sb, model), {
      file: "src/util.ts",
      startLine: 1,
      endLine: 3,
      instruction: "write the doubling as n + n",
    });
    expect(report.status).toBe("applied");
    expect(report.allowedFiles).toContain("src/util.ts");
    expect(readFileSync(join(sb.workspace, "src/util.ts"), "utf8")).toContain("return n + n;");
  });

  it("reports a bad line range as invalid input", async () => {
    const report = await runRefactorCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/util.ts",
      startLine: 1,
      endLine: 99,
      instruction: "x",
    });
    expect(report.error?.code).toBe("INVALID_INPUT");
  });
});

describe("rename command", () => {
  let sb: Sandbox;
  const SOURCE = [
    "export function add(a: number, b: number): number {",
    "  return a + b;",
    "}",
    "export const total = add(1, 2);",
    "",
  ].join("\n");

  beforeEach(() => {
    sb = makeSandbox("fcx-rename-");
    writeProject(sb.workspace, { "src/math.ts": SOURCE });
  });
  afterEach(() => sb.cleanup());

  it("renames the symbol everywhere it is used", async () => {
    const report = await runRenameCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/math.ts",
      line: 1,
      column: 17,
      newName: "sum",
    });
    expect(report.status).toBe("applied");
    expect(report.symbol).toBe("add");
    expect(report.changedFiles).toEqual(["src/math.ts"]);
    const text = readFileSync(join(sb.workspace, "src/math.ts"), "utf8");
    expect(text).toContain("export function sum(");
    expect(text).toContain("const total = sum(1, 2);");
  });

  it("asks the model for a name when none is given", async () => {
    const model = scriptedModel([{ newName: "sum" }]);
    const report = await runRenameCommand(recipeEnv(sb, model), {
      file: "src/math.ts",
      line: 1,
      column: 17,
    });
    expect(report.status).toBe("applied");
    expect(report.newName).toBe("sum");
    expect(model.prompts).toHaveLength(1);
  });

  it("rejects a name that is not an identifier", async () => {
    const report = await runRenameCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/math.ts",
      line: 1,
      column: 17,
      newName: "1abc",
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("INVALID_INPUT");
    expect(existsSync(join(sb.workspace, "src/math.ts"))).toBe(true);
  });
});
