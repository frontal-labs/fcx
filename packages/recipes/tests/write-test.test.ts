import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LayerEvent, RecipeInputError, runWriteTest } from "../src/index.js";
import { makeWorkspace, queueModel } from "./support.js";

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";

const GOOD = {
  file: "tests/add.test.ts",
  imports: ["../src/math.js"],
  testCode: 'import { add } from "../src/math.js";\n\nexport const sum: number = add(1, 2);\n',
};

describe("write-test", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/math.ts": MATH });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2) => ({
    model,
    workspace: fixture.ws,
    file: "src/math.ts",
    symbol: "add",
    indexPath: fixture.indexPath,
    maxCandidates,
  });

  it("verifies a new test file under tests/ whose imports resolve and that type-checks", async () => {
    const result = await runWriteTest(base(queueModel([GOOD]), 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.file).toBe("tests/math.test.ts");
      expect(result.testCode).toBe(GOOD.testCode);
      expect(result.verification.notRun.join(" ")).toMatch(/test-run/);
    }
  });

  it("uses the recipe's test path whatever path the model gives", async () => {
    const elsewhere = { ...GOOD, file: "src/add.test.ts" };
    const result = await runWriteTest(base(queueModel([elsewhere]), 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.file).toBe("tests/math.test.ts");
  });

  it("names a symbol-specific test file when the default name is taken", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({ "src/math.ts": MATH, "tests/math.test.ts": "export {};\n" });
    const result = await runWriteTest(base(queueModel([GOOD]), 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.file).toBe("tests/math.add.test.ts");
  });

  it("refuses to write when both candidate names are taken", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({
      "src/math.ts": MATH,
      "tests/math.test.ts": "export {};\n",
      "tests/math.add.test.ts": "export {};\n",
    });
    await expect(runWriteTest(base(queueModel([GOOD]), 1))).rejects.toThrow("already exist");
  });

  it("rewrites an import of the source that the model wrote from the workspace root", async () => {
    const rootImport = { ...GOOD, imports: ["src/math.js"], testCode: GOOD.testCode };
    const result = await runWriteTest(base(queueModel([rootImport]), 1));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.imports).toEqual(["../src/math"]);
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{ file: "tests/add.test.ts" }, GOOD]);
    const result = await runWriteTest(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.candidates[0]).toMatchObject({ pass: false });
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("rejects an import that does not resolve", async () => {
    const events: LayerEvent[] = [];
    const unresolved = { ...GOOD, imports: ["./nowhere.js"] };
    const result = await runWriteTest({
      ...base(queueModel([unresolved, unresolved])),
      onLayer: (e) => events.push(e),
    });
    expect(result.status).toBe("abstained");
    expect(events.filter((e) => e.layer === "constrain").map((e) => e.reasonCode)).toEqual([
      "IMPORT_NOT_RESOLVED",
      "IMPORT_NOT_RESOLVED",
    ]);
  });

  it("rejects an unknown symbol", async () => {
    await expect(
      runWriteTest({ ...base(queueModel([]), 1), symbol: "missing" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
