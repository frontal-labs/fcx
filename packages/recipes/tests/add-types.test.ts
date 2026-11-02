import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import {
  ADD_TYPES_SYSTEM,
  type AddTypesOptions,
  AddTypesSchema,
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

/** Annotates `add`'s return type. */
const ANNOTATE_ADD = {
  edits: [
    {
      file: FILE,
      search: "export function add(a: number, b: number) {",
      replace: "export function add(a: number, b: number): number {",
    },
  ],
};

/** Annotates SCALE. */
const ANNOTATE_SCALE = {
  edits: [
    { file: FILE, search: "export const SCALE = 2;", replace: "export const SCALE: number = 2;" },
  ],
};

describe("add-types prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(ADD_TYPES_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });
});

describe("AddTypesSchema", () => {
  it("accepts one to four edits", () => {
    expect(
      AddTypesSchema.safeParse({ edits: [{ file: FILE, search: "a", replace: "b" }] }).success,
    ).toBe(true);
  });

  it("rejects an empty edit list and more than four edits", () => {
    expect(AddTypesSchema.safeParse({ edits: [] }).success).toBe(false);
    const five = Array.from({ length: 5 }, () => ({ file: FILE, search: "a", replace: "b" }));
    expect(AddTypesSchema.safeParse({ edits: five }).success).toBe(false);
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
    const model = queueModel([ANNOTATE_SCALE]);
    const result = await runAddTypes({
      ...base(model),
      symbol: undefined,
      startLine: 1,
      endLine: 1,
      maxCandidates: 1,
    });
    expect(result).toMatchObject({ status: "verified", annotated: ["SCALE@1"] });
  });

  it("reports nothing-to-annotate, without calling the model, when the target is already typed", async () => {
    const model = queueModel([]);
    const result = await runAddTypes({ ...base(model), symbol: "typed" });
    expect(result).toMatchObject({ status: "nothing-to-annotate", file: FILE });
    expect(model.prompts).toHaveLength(0);
  });

  it("abstains when the candidate leaves the declaration without a type", async () => {
    const noop = {
      edits: [
        {
          file: FILE,
          search: "export function add(a: number, b: number) {",
          replace: "export function add(a: number, b: number) {",
        },
      ],
    };
    const result = await runAddTypes(base(queueModel([noop, noop])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.lastError).toMatch(/still has no explicit type/);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("rejects an any annotation", async () => {
    const anyType = {
      edits: [
        {
          file: FILE,
          search: "export function add(a: number, b: number) {",
          replace: "export function add(a: number, b: number): any {",
        },
      ],
    };
    const result = await runAddTypes(base(queueModel([anyType, anyType])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/annotated any/);
  });

  it("rejects an annotation that introduces a type error", async () => {
    const wrong = {
      edits: [
        {
          file: FILE,
          search: "export function add(a: number, b: number) {",
          replace: "export function add(a: number, b: number): string {",
        },
      ],
    };
    const result = await runAddTypes(base(queueModel([wrong, wrong])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/new error/);
  });

  it("rejects an edit to a file other than the one named", async () => {
    const elsewhere = {
      edits: [{ file: "src/other.ts", search: "x", replace: "y" }],
    };
    const result = await runAddTypes(base(queueModel([elsewhere, elsewhere])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates[0]?.layers[0]).toMatchObject({
        pass: false,
        reasonCode: "PATH_NOT_ALLOWED",
      });
    }
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

  it("refuses a symbol that is not declared in the file", async () => {
    await expect(
      runAddTypes({ ...base(queueModel([])), symbol: "missing" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a line range outside the file", async () => {
    await expect(
      runAddTypes({ ...base(queueModel([])), symbol: undefined, startLine: 1, endLine: 99 }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
