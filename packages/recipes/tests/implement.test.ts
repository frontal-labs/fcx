import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IMPLEMENT_SYSTEM, type LayerEvent, RecipeInputError, runImplement } from "../src/index.js";
import { makeWorkspace, queueModel } from "./support.js";

const STUB = [
  "/** Returns the sum of two numbers. */",
  "export function add(a: number, b: number): number {",
  '  throw new Error("not implemented");',
  "}",
  "",
].join("\n");

describe("implement", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/math.ts": STUB });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2) => ({
    model,
    workspace: fixture.ws,
    file: "src/math.ts",
    line: 3,
    indexPath: fixture.indexPath,
    maxCandidates,
  });

  it("verifies a body that type-checks and replaces only the stub", async () => {
    const model = queueModel([{ body: "return a + b;" }]);
    const result = await runImplement({ ...base(model), maxCandidates: 1 });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.replacement).toBe(
        "export function add(a: number, b: number): number {\nreturn a + b;\n}",
      );
    }
  });

  it("abstains when every candidate uses a name that is not in scope", async () => {
    const bad = { body: "return missingHelper(a, b);" };
    const events: LayerEvent[] = [];
    const result = await runImplement({
      ...base(queueModel([bad, bad])),
      onLayer: (e) => events.push(e),
    });
    expect(result.status).toBe("abstained");
    expect(events.filter((e) => e.layer === "ground").map((e) => e.reasonCode)).toEqual([
      "UNKNOWN_IDENTIFIER",
      "UNKNOWN_IDENTIFIER",
    ]);
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{}, { body: "return a + b;" }]);
    const result = await runImplement(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.candidates[0]).toMatchObject({ pass: false });
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("rejects a body that does not type-check", async () => {
    const bad = { body: "return a + b + notANumber;" };
    const result = await runImplement({ ...base(queueModel([bad]), 1) });
    expect(result.status).toBe("abstained");
  });

  it("sends the same prompt with no heading when instructions are absent or empty", async () => {
    const absent = queueModel([{ body: "return a + b;" }]);
    const empty = queueModel([{ body: "return a + b;" }]);
    await runImplement({ ...base(absent), maxCandidates: 1 });
    await runImplement({ ...base(empty), maxCandidates: 1, instructions: "" });
    expect(empty.prompts[0]).toBe(absent.prompts[0]);
    expect(
      absent.prompts[0]?.startsWith(`${IMPLEMENT_SYSTEM}\n\nAllowed files: src/math.ts\n`),
    ).toBe(true);
    expect(absent.prompts[0]).not.toContain("Project instructions:");
  });

  it("puts the heading and instruction text after the system text, before the task text", async () => {
    const absent = queueModel([{ body: "return a + b;" }]);
    const withRules = queueModel([{ body: "return a + b;" }]);
    await runImplement({ ...base(absent), maxCandidates: 1 });
    await runImplement({
      ...base(withRules),
      maxCandidates: 1,
      instructions: "Use early returns.",
    });
    expect(withRules.prompts[0]).toBe(
      `${IMPLEMENT_SYSTEM}\n\nProject instructions:\nUse early returns.\n\n${absent.prompts[0]?.slice(IMPLEMENT_SYSTEM.length + 2)}`,
    );
  });

  it("rejects a line with no function", async () => {
    await expect(runImplement({ ...base(queueModel([]), 1), line: 5 })).rejects.toBeInstanceOf(
      RecipeInputError,
    );
  });
});
