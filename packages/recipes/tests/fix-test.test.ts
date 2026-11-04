import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LayerEvent, RecipeInputError, runFixTest } from "../src/index.js";
import { makeWorkspace, queueModel } from "./support.js";

const MATH = "export function add(a: number, b: number): number {\n  return a - b;\n}\n";
const OTHER = 'export const unrelated: number = "x";\n';
const TEST = [
  'import { add } from "../src/math.js";',
  "",
  'it("adds two numbers", () => {',
  "  const sum: number = add(1, 2);",
  '  if (sum !== 3) throw new Error("expected 3");',
  "});",
  "",
].join("\n");

describe("fix-test", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({
      "src/math.ts": MATH,
      "src/other.ts": OTHER,
      "tests/math.test.ts": TEST,
      // The test runner's globals, so the test file type-checks apart from the bug the recipe fixes.
      "tests/globals.d.ts": "declare function it(name: string, fn: () => void): void;\n",
    });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2) => ({
    model,
    workspace: fixture.ws,
    testFile: "tests/math.test.ts",
    testName: "adds two numbers",
    indexPath: fixture.indexPath,
    maxCandidates,
  });

  const RETURN_FIX = {
    fixes: [{ file: "src/math.ts", startLine: 2, endLine: 2, replacement: "  return a + b;" }],
  };

  it("verifies a line-range fix to the function under test and says the test was not run", async () => {
    const model = queueModel([RETURN_FIX]);
    const result = await runFixTest(base(model, 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.edits[0]).toMatchObject({ file: "src/math.ts" });
      expect(result.edits[0]?.replace).toContain("return a + b;");
      expect(result.verification.notRun.join(" ")).toMatch(/test-run/);
    }
    expect(model.prompts[0]).toContain('Failing test: "adds two numbers"');
    expect(model.prompts[0]).toContain("First failure output: (not available)");
  });

  it("rejects a fix whose lines are outside the file", async () => {
    const outside = {
      fixes: [{ file: "src/math.ts", startLine: 9, endLine: 9, replacement: "x" }],
    };
    const result = await runFixTest(base(queueModel([outside, outside])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]?.error).toMatch(/outside src\/math\.ts/);
    }
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{ fixes: [] }, RETURN_FIX]);
    const result = await runFixTest(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified")
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
    expect(model.prompts[1]).toContain("between one and four fixes");
  });

  it("rejects a fix that leaves the test file with the type error it was asked to fix", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({
      "src/math.ts": MATH,
      "tests/math.test.ts": TEST.replace("add(1, 2)", "add(1)"),
      "tests/globals.d.ts": "declare function it(name: string, fn: () => void): void;\n",
    });
    const unrelated = {
      fixes: [
        {
          file: "tests/math.test.ts",
          startLine: 3,
          endLine: 3,
          replacement: 'it("adds two numbers.", () => {',
        },
      ],
    };
    const result = await runFixTest(base(queueModel([unrelated, unrelated])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates[0]?.layers.at(-1)).toMatchObject({ reasonCode: "TARGET_NOT_FIXED" });
    }
  });

  it("never edits a file outside the allowed set", async () => {
    const model = queueModel([
      { fixes: [{ file: "src/other.ts", startLine: 1, endLine: 1, replacement: "1" }] },
    ]);
    // A one-token budget keeps optional blocks out, so src/other.ts is not in the bundle's allow-list.
    const result = await runFixTest({ ...base(model, 1), contextBudgetTokens: 1 });
    // With one allowed file, a fix that names another path is pointed at that file, never at the other one.
    expect(JSON.stringify(result)).not.toContain("src/other.ts");
  });

  it("rejects a test name that is not in the file", async () => {
    await expect(
      runFixTest({ ...base(queueModel([]), 1), testName: "missing" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
