import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type LayerEvent,
  type RecipeDefinition,
  editsSchema,
  runRecipeEngine,
} from "../src/index.js";
import { makeWorkspace, queueModel } from "./support.js";

describe("runRecipeEngine", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/a.ts": 'export const n: number = "5";\n' });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const recipe = (): RecipeDefinition<{
    edits: { file: string; search: string; replace: string }[];
  }> => ({
    schema: editsSchema(4),
    temperatures: [0.2],
    prompt: (feedback) => ({ system: "SYS", user: feedback ?? "USER" }),
    toEdits: (output) => output.edits,
    layers: [{ name: "constrain" }, { name: "anchor" }],
  });

  it("returns no-diagnostics without calling the model when the caller has no work", async () => {
    const model = queueModel([]);
    const result = await runRecipeEngine({
      recipe: recipe(),
      model,
      workspace: fixture.ws,
      allowedFiles: [`${fixture.ws}/src/a.ts`],
      primaryFile: `${fixture.ws}/src/a.ts`,
      maxCandidates: 2,
      hasWork: false,
    });
    expect(result).toEqual({ status: "no-diagnostics", file: `${fixture.ws}/src/a.ts` });
    expect(model.prompts).toHaveLength(0);
  });

  it("sends the system and user text as one prompt, with the system first", async () => {
    const model = queueModel([{ edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] }]);
    await runRecipeEngine({
      recipe: recipe(),
      model,
      workspace: fixture.ws,
      allowedFiles: [`${fixture.ws}/src/a.ts`],
      primaryFile: `${fixture.ws}/src/a.ts`,
      maxCandidates: 1,
    });
    expect(model.prompts[0]).toBe("SYS\n\nUSER");
  });

  it("creates a file when an edit has an empty search and the file does not exist", async () => {
    const events: LayerEvent[] = [];
    const model = queueModel([
      { edits: [{ file: "tests/new.ts", search: "", replace: "export {};\n" }] },
    ]);
    const result = await runRecipeEngine({
      recipe: recipe(),
      model,
      workspace: fixture.ws,
      allowedFiles: [`${fixture.ws}/tests/new.ts`],
      primaryFile: `${fixture.ws}/src/a.ts`,
      maxCandidates: 1,
      onLayer: (e) => events.push(e),
    });
    expect(result.status).toBe("verified");
    if (result.status === "verified")
      expect(result.texts.get(`${fixture.ws}/tests/new.ts`)).toBe("export {};\n");
    expect(events.map((e) => `${e.layer}:${e.pass}`)).toEqual(["constrain:true", "anchor:true"]);
  });

  it("tries a compiler candidate first and reports it as source compiler, without calling the model", async () => {
    const withCompiler = {
      ...recipe(),
      compiler: () => [{ file: "src/a.ts", search: '"5"', replace: "5" }],
    };
    const model = queueModel([]);
    const result = await runRecipeEngine({
      recipe: withCompiler,
      model,
      workspace: fixture.ws,
      allowedFiles: [`${fixture.ws}/src/a.ts`],
      primaryFile: `${fixture.ws}/src/a.ts`,
      maxCandidates: 1,
    });
    expect(result).toMatchObject({ status: "verified", source: "compiler", output: undefined });
    expect(model.prompts).toHaveLength(0);
  });
});

describe("runRecipeEngine project instructions", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/a.ts": 'export const n: number = "5";\n' });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const recipe = (): RecipeDefinition<{
    edits: { file: string; search: string; replace: string }[];
  }> => ({
    schema: editsSchema(4),
    temperatures: [0.2],
    prompt: () => ({ system: "SYS", user: "USER" }),
    toEdits: (output) => output.edits,
    layers: [{ name: "constrain" }, { name: "anchor" }],
  });

  const run = (instructions: string | undefined, outputs: unknown[]) => {
    const model = queueModel(outputs);
    return runRecipeEngine({
      recipe: recipe(),
      model,
      workspace: fixture.ws,
      allowedFiles: [`${fixture.ws}/src/a.ts`],
      primaryFile: `${fixture.ws}/src/a.ts`,
      maxCandidates: 1,
      instructions,
    }).then((result) => ({ result, prompt: model.prompts[0] }));
  };

  const goodEdit = { edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] };

  it("puts the instruction block after the system text and before the user text", async () => {
    const { prompt, result } = await run("Use tabs.\nNo default exports.", [goodEdit]);
    expect(prompt).toBe("SYS\n\nProject instructions:\nUse tabs.\nNo default exports.\n\nUSER");
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.instructionsTruncated).toBe(false);
  });

  it("sends the same prompt for undefined and empty instructions", async () => {
    const without = await run(undefined, [goodEdit]);
    const empty = await run("", [goodEdit]);
    expect(without.prompt).toBe("SYS\n\nUSER");
    expect(empty.prompt).toBe(without.prompt);
  });

  it("cuts long instructions at a line boundary, sends only the kept lines, and reports it", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `rule ${i}`.padEnd(100, "-"));
    const { prompt, result } = await run(lines.join("\n"), [
      { edits: [{ file: "src/a.ts", search: "nothing here", replace: "x" }] },
    ]);
    expect(prompt).toBe(`SYS\n\nProject instructions:\n${lines.slice(0, 11).join("\n")}\n\nUSER`);
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.instructionsTruncated).toBe(true);
  });
});
