import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import {
  RENAME_EXTRACT_SYSTEM,
  type RenameExtractOptions,
  RenameSchema,
  isValidIdentifier,
  runRenameExtract,
} from "../src/recipes/rename-extract.js";
import { makeWorkspace, promptBody, queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "rename-extract.md");

const FILE = "src/math.ts";

const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "export const total = add(1, 2);",
  "",
].join("\n");

/** Column 17 on line 1 is the `a` of `add`. */
const AT_ADD = { line: 1, column: 17 };

describe("rename-extract prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(RENAME_EXTRACT_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });
});

describe("isValidIdentifier", () => {
  it("accepts identifiers and rejects bad names and reserved words", () => {
    expect(isValidIdentifier("sum")).toBe(true);
    expect(isValidIdentifier("_$x1")).toBe(true);
    expect(isValidIdentifier("1abc")).toBe(false);
    expect(isValidIdentifier("my-name")).toBe(false);
    expect(isValidIdentifier("")).toBe(false);
    expect(isValidIdentifier("class")).toBe(false);
    expect(isValidIdentifier("await")).toBe(false);
  });
});

describe("RenameSchema", () => {
  it("accepts a non-empty newName", () => {
    expect(RenameSchema.safeParse({ newName: "sum" }).success).toBe(true);
    expect(RenameSchema.safeParse({ newName: "" }).success).toBe(false);
    expect(RenameSchema.safeParse({}).success).toBe(false);
  });
});

describe("runRenameExtract", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ [FILE]: SOURCE });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2): RenameExtractOptions => ({
    model,
    workspace: fixture.ws,
    file: FILE,
    ...AT_ADD,
    maxCandidates,
  });

  it("renames every use with the language service's edits and returns the verified texts", async () => {
    const model = queueModel([]);
    const result = await runRenameExtract({ ...base(model), newName: "sum" });
    expect(result).toMatchObject({
      status: "verified",
      symbol: "add",
      newName: "sum",
      locations: 2,
    });
    if (result.status === "verified") {
      expect(result.files).toHaveLength(1);
      expect(result.files[0]).toMatchObject({ file: FILE, baseText: SOURCE });
      expect(result.files[0]?.text).toBe(
        SOURCE.replace("function add(", "function sum(").replace("= add(1, 2)", "= sum(1, 2)"),
      );
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("keeps shorthand properties working by writing the prefix the language service gives", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({
      [FILE]:
        "export const add = (a: number, b: number): number => a + b;\nexport const ops = { add };\n",
    });
    const result = await runRenameExtract({
      ...base(queueModel([])),
      line: 1,
      column: 14,
      newName: "sum",
    });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.files[0]?.text).toContain(
        "export const sum = (a: number, b: number): number => a + b;",
      );
      expect(result.files[0]?.text).toContain("export const ops = { add: sum };");
    }
  });

  it("abstains without calling the model when the new name clashes with an existing one", async () => {
    const model = queueModel([]);
    const result = await runRenameExtract({ ...base(model), newName: "total" });
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.lastError).toMatch(/new error/);
      expect(result.candidates).toHaveLength(1);
    }
    expect(model.prompts).toHaveLength(0);
  });

  it("verifies a name the model proposes, and calls the model once", async () => {
    const model = queueModel([{ newName: "sum" }]);
    const result = await runRenameExtract({ ...base(model), maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", newName: "sum" });
    expect(model.prompts).toHaveLength(1);
  });

  it("abstains when every proposed name is invalid or clashes", async () => {
    const model = queueModel([{ newName: "class" }, { newName: "total" }]);
    const result = await runRenameExtract(base(model));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]?.layers[0]).toMatchObject({
        pass: false,
        reasonCode: "INVALID_NAME",
      });
      expect(result.candidates[1]?.layers.at(-1)).toMatchObject({ pass: false, layer: "verify" });
    }
  });

  it("records a schema-invalid proposal as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{}, { newName: "sum" }]);
    const result = await runRenameExtract(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
    }
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("refuses a new name that is not a valid identifier or is a reserved word", async () => {
    await expect(
      runRenameExtract({ ...base(queueModel([])), newName: "1abc" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
    await expect(
      runRenameExtract({ ...base(queueModel([])), newName: "class" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses the current name as the new name", async () => {
    await expect(
      runRenameExtract({ ...base(queueModel([])), newName: "add" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a position that is not on a renameable identifier", async () => {
    await expect(
      runRenameExtract({ ...base(queueModel([])), line: 3, column: 1, newName: "sum" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a column outside the line, and a file that is not TypeScript", async () => {
    await expect(
      runRenameExtract({ ...base(queueModel([])), column: 500, newName: "sum" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
    await expect(
      runRenameExtract({ ...base(queueModel([])), file: "src/notes.md", newName: "sum" }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });
});
