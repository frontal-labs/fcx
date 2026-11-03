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

  it("verifies an edit to the function under test and says the test was not run", async () => {
    const model = queueModel([
      { edits: [{ file: "src/math.ts", search: "return a - b;", replace: "return a + b;" }] },
    ]);
    const result = await runFixTest(base(model, 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.edits[0]).toMatchObject({ file: "src/math.ts", replace: "return a + b;" });
      expect(result.verification.notRun.join(" ")).toMatch(/test-run/);
    }
    expect(model.prompts[0]).toContain('Failing test: "adds two numbers"');
    expect(model.prompts[0]).toContain("First failure output: (not available)");
  });

  it("abstains when every candidate is rejected by the anchor layer", async () => {
    const bad = {
      edits: [{ file: "src/math.ts", search: "return a * b;", replace: "return a + b;" }],
    };
    const result = await runFixTest(base(queueModel([bad, bad])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates).toHaveLength(2);
      expect(result.lastError).toMatch(/does not match the file exactly/);
    }
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([
      { edits: [] },
      { edits: [{ file: "src/math.ts", search: "return a - b;", replace: "return a + b;" }] },
    ]);
    const result = await runFixTest(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified")
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("rejects an edit that leaves the test file with the type error it was asked to fix", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({
      "src/math.ts": MATH,
      "tests/math.test.ts": TEST.replace("add(1, 2)", "add(1)"),
      "tests/globals.d.ts": "declare function it(name: string, fn: () => void): void;\n",
    });
    const unrelated = {
      edits: [
        { file: "tests/math.test.ts", search: "adds two numbers", replace: "adds two numbers." },
      ],
    };
    const result = await runFixTest(base(queueModel([unrelated, unrelated])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates[0]?.layers.at(-1)).toMatchObject({ reasonCode: "TARGET_NOT_FIXED" });
    }
  });

  it("rejects an edit to a file outside the allowed set", async () => {
    const events: LayerEvent[] = [];
    const model = queueModel([{ edits: [{ file: "src/other.ts", search: '"x"', replace: "1" }] }]);
    // A one-token budget keeps optional blocks out, so src/other.ts is not in the bundle's allow-list.
    const result = await runFixTest({
      ...base(model, 1),
      contextBudgetTokens: 1,
      onLayer: (e) => events.push(e),
    });
    expect(result.status).toBe("abstained");
    expect(events[0]).toMatchObject({
      layer: "constrain",
      pass: false,
      reasonCode: "PATH_NOT_ALLOWED",
    });
  });

  it("rejects a test name that is not in the file", async () => {
    await expect(
      runFixTest({ ...base(queueModel([]), 1), testName: "missing" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
