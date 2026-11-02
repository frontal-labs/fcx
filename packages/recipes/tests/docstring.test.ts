import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import {
  DOCSTRING_SYSTEM,
  type DocstringOptions,
  DocstringSchema,
  runDocstring,
} from "../src/recipes/docstring.js";
import { makeWorkspace, promptBody, queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "docstring.md");

const FILE = "src/math.ts";

const SOURCE = [
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export class Counter {",
  "  private n = 0;",
  "",
  "  bump(by: number): number {",
  "    this.n += by;",
  "    return this.n;",
  "  }",
  "}",
  "",
].join("\n");

const DOC =
  "/**\n * Adds two numbers.\n * @param a The first addend.\n * @param b The second addend.\n * @returns The sum.\n */";

describe("docstring prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(DOCSTRING_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });
});

describe("DocstringSchema", () => {
  it("accepts a doc string and rejects a missing or empty one", () => {
    expect(DocstringSchema.safeParse({ doc: DOC }).success).toBe(true);
    expect(DocstringSchema.safeParse({ doc: "" }).success).toBe(false);
    expect(DocstringSchema.safeParse({}).success).toBe(false);
  });
});

describe("runDocstring", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ [FILE]: SOURCE });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const base = (model: ReturnType<typeof queueModel>, line = 1): DocstringOptions => ({
    model,
    workspace: fixture.ws,
    file: FILE,
    line,
    maxCandidates: 2,
  });

  it("verifies a doc block inserted above a function, with the declaration unchanged", async () => {
    const model = queueModel([{ doc: DOC }]);
    const result = await runDocstring({ ...base(model), maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", file: FILE, line: 1, doc: DOC });
    if (result.status === "verified") {
      expect(result.text).toBe(`${DOC}\n${SOURCE}`);
      expect(result.text).toContain(
        "export function add(a: number, b: number): number {\n  return a + b;\n}",
      );
    }
  });

  it("indents the doc block for a method and keeps the method unchanged", async () => {
    const model = queueModel([
      { doc: "/**\n* Adds an amount to the count.\n* @param by Amount to add.\n*/" },
    ]);
    const result = await runDocstring({ ...base(model), line: 8, maxCandidates: 1 });
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.text).toContain(
        "  /**\n   * Adds an amount to the count.\n   * @param by Amount to add.\n   */\n  bump(by: number): number {\n    this.n += by;",
      );
    }
  });

  it("finds the declaration from a line inside a class member, not the class", async () => {
    const model = queueModel([{ doc: "/** Adds to the count. */" }]);
    const result = await runDocstring({ ...base(model), line: 9, maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", line: 8 });
  });

  it("abstains when every candidate contains a code fence", async () => {
    const fenced = { doc: "/**\n * Adds.\n * ```ts\n * add(1, 2)\n * ```\n */" };
    const result = await runDocstring(base(queueModel([fenced, fenced])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/code fence/);
  });

  it("rejects output that is code after the comment block, and abstains", async () => {
    const code = { doc: "/**\n * Adds.\n */\nconst total = add(1, 2);" };
    const result = await runDocstring(base(queueModel([code, code])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/opening delimiter/);
  });

  it("rejects a line inside the block that is code, and abstains", async () => {
    const code = { doc: "/**\n * Adds.\n const total = add(1, 2);\n */" };
    const result = await runDocstring(base(queueModel([code, code])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/not comment text/);
  });

  it("rejects a doc with a second closing delimiter in the middle", async () => {
    const broken = { doc: "/** Adds. */ */" };
    const result = await runDocstring(base(queueModel([broken, broken])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.lastError).toMatch(/opening delimiter/);
  });

  it("records a schema-invalid output as a failed candidate and then verifies the next one", async () => {
    const model = queueModel([{}, { doc: DOC }]);
    const result = await runDocstring(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
    }
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("refuses a declaration that already has a doc block", async () => {
    fixture.cleanup();
    fixture = makeWorkspace({
      [FILE]:
        "/** Already documented. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
    });
    await expect(runDocstring(base(queueModel([]), 2))).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a line that is not inside a declaration", async () => {
    await expect(runDocstring(base(queueModel([]), 4))).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a line outside the file", async () => {
    await expect(runDocstring(base(queueModel([]), 500))).rejects.toBeInstanceOf(RecipeInputError);
  });
});
