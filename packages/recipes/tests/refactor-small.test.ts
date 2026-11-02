import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LayerEvent, RecipeInputError, runRefactorSmall } from "../src/index.js";
import { makeWorkspace, queueModel } from "./support.js";

const UTIL = "export function double(n: number): number {\n  return n * 2;\n}\n";
const APP = 'import { double } from "./util.js";\n\nexport const four: number = double(2);\n';
const OTHER = 'export const label: string = "x";\n';

describe("refactor-small", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/util.ts": UTIL, "src/app.ts": APP, "src/other.ts": OTHER });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2) => ({
    model,
    workspace: fixture.ws,
    file: "src/util.ts",
    startLine: 1,
    endLine: 3,
    instruction: "write the doubling as n + n",
    indexPath: fixture.indexPath,
    maxCandidates,
  });

  it("verifies an edit inside the selection and reports the callers it may touch", async () => {
    const model = queueModel([
      { edits: [{ file: "src/util.ts", search: "return n * 2;", replace: "return n + n;" }] },
    ]);
    const result = await runRefactorSmall({ ...base(model), maxCandidates: 1 });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.allowedFiles).toEqual(["src/util.ts", "src/app.ts"]);
      expect(result.edits[0]).toMatchObject({ file: "src/util.ts", replace: "return n + n;" });
    }
    expect(model.prompts[0]).toContain("Callers of the symbols declared in the selection");
  });

  it("abstains when every candidate's search text does not match", async () => {
    const bad = { edits: [{ file: "src/util.ts", search: "return n / 2;", replace: "return n;" }] };
    const result = await runRefactorSmall(base(queueModel([bad, bad])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained")
      expect(result.lastError).toMatch(/does not match the file exactly/);
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([
      { edits: [] },
      { edits: [{ file: "src/util.ts", search: "return n * 2;", replace: "return n + n;" }] },
    ]);
    const result = await runRefactorSmall(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.candidates[0]).toMatchObject({ pass: false });
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("rejects an edit to a file that is neither the selection nor a caller", async () => {
    const events: LayerEvent[] = [];
    const model = queueModel([
      { edits: [{ file: "src/other.ts", search: '"x"', replace: '"y"' }] },
    ]);
    const result = await runRefactorSmall({ ...base(model, 1), onLayer: (e) => events.push(e) });
    expect(result.status).toBe("abstained");
    expect(events[0]).toMatchObject({
      layer: "constrain",
      pass: false,
      reasonCode: "PATH_NOT_ALLOWED",
    });
  });

  it("rejects a range outside the file", async () => {
    await expect(
      runRefactorSmall({ ...base(queueModel([]), 1), endLine: 99 }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
