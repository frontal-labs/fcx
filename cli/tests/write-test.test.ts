import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatWriteTest,
  parseWriteTestTarget,
  runWriteTestCommand,
} from "../src/commands/write-test.js";
import { exitCodeFor } from "../src/lib/recipe-runtime.js";
import { recipeEnv, writeProject } from "./recipe-support.js";
import { type Sandbox, makeSandbox, scriptedModel } from "./support.js";

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const GOOD = {
  file: "tests/add.test.ts",
  imports: ["../src/math.js"],
  testCode: 'import { add } from "../src/math.js";\n\nexport const sum: number = add(1, 2);\n',
};

describe("parseWriteTestTarget", () => {
  it("takes file:symbol and rejects a missing symbol", () => {
    expect(parseWriteTestTarget("src/math.ts:add")).toEqual({ file: "src/math.ts", symbol: "add" });
    expect(parseWriteTestTarget("src/math.ts")).toMatch(/file:symbol/);
    expect(parseWriteTestTarget(undefined)).toMatch(/usage/);
  });
});

describe("fcx test (write-test)", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-wt-");
    writeProject(sb.workspace, { "src/math.ts": MATH });
  });
  afterEach(() => sb.cleanup());

  it("proposes the test for the symbol and does not write the file", async () => {
    const report = await runWriteTestCommand(recipeEnv(sb, scriptedModel([GOOD])), {
      file: "src/math.ts",
      symbol: "add",
    });
    expect(report).toMatchObject({
      command: "test",
      recipe: "write-test",
      status: "proposed",
      file: "tests/add.test.ts",
      symbol: "add",
    });
    expect(report.testCode).toBe(GOOD.testCode);
    expect(report.warnings.join(" ")).toMatch(/not written/);
    expect(existsSync(join(sb.workspace, "tests/add.test.ts"))).toBe(false);
    expect(readFileSync(join(sb.workspace, "src/math.ts"), "utf8")).toBe(MATH);
    expect(exitCodeFor(report.status)).toBe(0);
  });

  it("text output shows the test file and the code", async () => {
    const report = await runWriteTestCommand(recipeEnv(sb, scriptedModel([GOOD])), {
      file: "src/math.ts",
      symbol: "add",
    });
    const text = formatWriteTest(report);
    expect(text).toContain("fcx test src/math.ts:add: proposed");
    expect(text).toContain("test file: tests/add.test.ts");
    expect(text).toContain("export const sum: number = add(1, 2);");
  });

  it("abstains with exit 2 when every candidate fails verification", async () => {
    const bad = {
      file: "tests/add.test.ts",
      imports: [],
      testCode: "export const x: number = missing;\n",
    };
    const report = await runWriteTestCommand(recipeEnv(sb, scriptedModel([bad])), {
      file: "src/math.ts",
      symbol: "add",
    });
    expect(report.status).toBe("abstained");
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it("reports an unknown symbol as invalid input", async () => {
    const report = await runWriteTestCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/math.ts",
      symbol: "missing",
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("INVALID_INPUT");
    expect(exitCodeFor(report.status)).toBe(1);
  });
});
