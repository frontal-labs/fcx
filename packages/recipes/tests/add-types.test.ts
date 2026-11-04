import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import {
  ADD_TYPES_SYSTEM,
  type AddTypesOptions,
  AddTypesSchema,
  annotationEdits,
  runAddTypes,
} from "../src/recipes/add-types.js";
import { makeWorkspace, promptBody, queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "add-types.md");

const SOURCE = [
  "export const SCALE = 2;",
  "export function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "export const typed: number = 1;",
  "",
].join("\n");

const FILE = "src/math.ts";

/** Gives `add` its return type. */
const ANNOTATE_ADD = { types: [{ name: "add", line: 2, type: "number" }] };

/** Gives SCALE its type. */
const ANNOTATE_SCALE = { types: [{ name: "SCALE", line: 1, type: "number" }] };

describe("add-types prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(ADD_TYPES_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });
});

describe("AddTypesSchema", () => {
  it("accepts one to twelve typed targets", () => {
    expect(
      AddTypesSchema.safeParse({ types: [{ name: "add", line: 2, type: "number" }] }).success,
    ).toBe(true);
  });

  it("requires the types list and its fields; bounds are checked in code", () => {
    expect(AddTypesSchema.safeParse({ edits: [{ file: FILE }] }).success).toBe(false);
    expect(AddTypesSchema.safeParse({ types: [{ name: "a", line: 1 }] }).success).toBe(false);
  });

  it("drops an empty or code-like type, so the annotation layer asks for it again", () => {
    const text = "export const a = 1;\n";
    const abs = `${FILE}`;
    expect(
      annotationEdits(text, FILE, abs, [], [{ name: "a", line: 1, type: "{ x: 1 }" }]),
    ).toEqual([]);
  });
});

describe("runAddTypes", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ [FILE]: SOURCE });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2): AddTypesOptions => ({
    model,
    workspace: fixture.ws,
    file: FILE,
    symbol: "add",
    maxCandidates,
  });

  it("verifies a symbol annotation and sends the compiler's type information", async () => {
    const model = queueModel([ANNOTATE_ADD]);
    const result = await runAddTypes({ ...base(model), maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", file: FILE, annotated: ["add@2"] });
    if (result.status === "verified") {
      expect(result.text).toContain("export function add(a: number, b: number): number {");
    }
    expect(model.prompts[0]).toContain("function add(a: number, b: number): number");
  });

  it("verifies a range annotation", async () => {
    const result = await runAddTypes({
      ...base(queueModel([ANNOTATE_SCALE])),
      symbol: undefined,
      startLine: 1,
      endLine: 1,
      maxCandidates: 1,
    });
    expect(result).toMatchObject({ status: "verified", annotated: ["SCALE@1"] });
    if (result.status === "verified") {
      expect(result.text).toContain("export const SCALE: number = 2;");
    }
  });

  it("reports nothing-to-annotate, without calling the model, when the target is already typed", async () => {
    const model = queueModel([]);
    const result = await runAddTypes({ ...base(model), symbol: "typed" });
    expect(result).toMatchObject({ status: "nothing-to-annotate", file: FILE });
    expect(model.prompts).toHaveLength(0);
  });

  it("abstains when the model gives no type for the declaration", async () => {
    const wrongName = { types: [{ name: "nothere", line: 2, type: "number" }] };
    const result = await runAddTypes(base(queueModel([wrongName, wrongName])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.lastError).toMatch(/still has no explicit type/);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("rejects an any annotation", async () => {
    const anyType = { types: [{ name: "add", line: 2, type: "any" }] };
    const result = await runAddTypes(base(queueModel([anyType, anyType])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/annotated any/);
  });

  it("rejects an annotation that introduces a type error", async () => {
    const wrong = { types: [{ name: "add", line: 2, type: "string" }] };
    const result = await runAddTypes(base(queueModel([wrong, wrong])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/new error/);
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{}, ANNOTATE_ADD]);
    const result = await runAddTypes(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
      expect(result.candidates[0]?.error).toBeDefined();
    }
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("refuses a file that is not TypeScript", async () => {
    await expect(
      runAddTypes({ ...base(queueModel([])), file: "src/notes.js" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a request with both a symbol and a range, or with neither", async () => {
    await expect(
      runAddTypes({ ...base(queueModel([])), startLine: 1, endLine: 1 }),
    ).rejects.toBeInstanceOf(RecipeInputError);
    await expect(
      runAddTypes({ ...base(queueModel([])), symbol: undefined }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
