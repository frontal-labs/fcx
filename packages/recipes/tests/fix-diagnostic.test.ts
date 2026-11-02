import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Checker, createTsChecker } from "@fcx/verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FIX_DIAGNOSTIC_SYSTEM, FixOutputSchema, runFixDiagnostic } from "../src/index.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "fix-diagnostic.md");

/** A model stand-in: returns queued outputs and records prompts. */
function queueModel(outputs: unknown[]) {
  const prompts: string[] = [];
  return {
    prompts,
    generateObject: async (req: { prompt: string }) => {
      prompts.push(req.prompt);
      const object = outputs.shift();
      if (object === undefined) throw new Error("ran out of outputs");
      return { object, ms: 0, raw: "" };
    },
  };
}

describe("fix-diagnostic prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    const source = readFileSync(PROMPT_FILE, "utf-8");
    const body = source
      .split("\n")
      .filter(
        (line, i, all) =>
          !(
            line.startsWith("//") &&
            all.slice(0, i + 1).every((l) => l.startsWith("//") || l === "")
          ),
      )
      .join("\n")
      .trim();
    expect(FIX_DIAGNOSTIC_SYSTEM).toBe(body);
  });
});

describe("FixOutputSchema", () => {
  it("accepts one to four edits", () => {
    expect(
      FixOutputSchema.safeParse({ edits: [{ file: "a.ts", search: "a", replace: "b" }] }).success,
    ).toBe(true);
  });

  it("rejects an empty edit list and more than four edits", () => {
    expect(FixOutputSchema.safeParse({ edits: [] }).success).toBe(false);
    const five = Array.from({ length: 5 }, () => ({ file: "a.ts", search: "a", replace: "b" }));
    expect(FixOutputSchema.safeParse({ edits: five }).success).toBe(false);
  });

  it("rejects an edit without a file", () => {
    expect(FixOutputSchema.safeParse({ edits: [{ search: "a", replace: "b" }] }).success).toBe(
      false,
    );
  });
});

describe("runFixDiagnostic", () => {
  let ws: string;
  let file: string;
  let checker: Checker;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-recipe-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    file = join(ws, "src", "a.ts");
    writeFileSync(file, 'export const n: number = "5";\n');
    checker = createTsChecker(ws, file);
  });

  afterEach(() => {
    checker.dispose();
    rmSync(ws, { recursive: true, force: true });
  });

  const base = () => ({ checker, workspace: ws, file, maxCandidates: 2 });

  it("reports no-diagnostics for a clean file, without calling the model", async () => {
    writeFileSync(file, "export const n = 5;\n");
    checker.dispose();
    checker = createTsChecker(ws, file);
    const model = queueModel([]);
    const result = await runFixDiagnostic({ ...base(), model });
    expect(result.status).toBe("no-diagnostics");
    expect(model.prompts).toHaveLength(0);
  });

  it("abstains with the last failure when every candidate is rejected", async () => {
    const model = queueModel([
      { edits: [{ file: "src/a.ts", search: "nothing here", replace: "x" }] },
      { edits: [{ file: "src/a.ts", search: "nothing here", replace: "x" }] },
    ]);
    const result = await runFixDiagnostic({ ...base(), model });
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.lastError).toMatch(/does not match the file exactly/);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("records a schema-invalid output as a failed candidate and keeps going", async () => {
    const model = queueModel([
      { edits: [] },
      { edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] },
    ]);
    const result = await runFixDiagnostic({ ...base(), model });
    expect(result.status).toBe("verified");
    expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
    expect(result.candidates[0]?.error).toBeDefined();
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("verifies a model edit and returns the text it was verified against", async () => {
    const model = queueModel([{ edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] }]);
    const result = await runFixDiagnostic({ ...base(), model });
    expect(result).toMatchObject({
      status: "verified",
      file,
      baseText: 'export const n: number = "5";\n',
    });
  });

  it("propagates a model that cannot load, rather than treating it as a bad candidate", async () => {
    const model = {
      generateObject: async () => {
        throw Object.assign(new Error("cannot load"), { code: "MODEL_LOAD_ERROR" });
      },
    };
    await expect(runFixDiagnostic({ ...base(), model })).rejects.toThrow("cannot load");
  });

  it("prefers the compiler's quick fix and never calls the model when it passes", async () => {
    writeFileSync(
      join(ws, "src", "helper.ts"),
      "export function helper(): number {\n  return 1;\n}\n",
    );
    writeFileSync(file, "export const v: number = helper();\n");
    checker.dispose();
    checker = createTsChecker(ws, file);
    const model = queueModel([]);
    const result = await runFixDiagnostic({ ...base(), model });
    expect(result.status).toBe("verified");
    if (result.status === "verified") expect(result.candidates[0]?.source).toBe("compiler");
    expect(model.prompts).toHaveLength(0);
  });

  it("emits a layer event for every check it runs", async () => {
    const events: string[] = [];
    const model = queueModel([{ edits: [{ file: "src/a.ts", search: '"5"', replace: "5" }] }]);
    await runFixDiagnostic({
      ...base(),
      model,
      onLayer: (e) => events.push(`${e.layer}:${e.pass}`),
    });
    expect(events).toEqual(["constrain:true", "anchor:true", "verify:true"]);
  });
});

describe("fix-diagnostic project instructions", () => {
  let ws: string;
  let file: string;
  let checker: Checker;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-recipe-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    file = join(ws, "src", "a.ts");
    writeFileSync(file, 'export const n: number = "5";\n');
    checker = createTsChecker(ws, file);
  });

  afterEach(() => {
    checker.dispose();
    rmSync(ws, { recursive: true, force: true });
  });

  // One candidate that cannot anchor, so the run abstains after one model call and the prompt is recorded.
  const run = async (instructions: string | undefined) => {
    const model = queueModel([
      { edits: [{ file: "src/a.ts", search: "nothing here", replace: "x" }] },
    ]);
    const result = await runFixDiagnostic({
      model,
      checker,
      workspace: ws,
      file,
      maxCandidates: 1,
      instructions,
    });
    return { result, prompt: model.prompts[0] ?? "" };
  };

  it("sends the system text first and no heading when instructions are absent or empty", async () => {
    const absent = await run(undefined);
    const empty = await run("");
    expect(empty.prompt).toBe(absent.prompt);
    expect(absent.prompt.startsWith(`${FIX_DIAGNOSTIC_SYSTEM}\n\nAllowed files: src/a.ts\n`)).toBe(
      true,
    );
    expect(absent.prompt).not.toContain("Project instructions:");
  });

  it("puts the heading and instruction text after the system text, before the task text", async () => {
    const without = await run(undefined);
    const withRules = await run("Use tabs.\nNo default exports.");
    expect(withRules.prompt).toBe(
      `${FIX_DIAGNOSTIC_SYSTEM}\n\nProject instructions:\nUse tabs.\nNo default exports.\n\n${without.prompt.slice(FIX_DIAGNOSTIC_SYSTEM.length + 2)}`,
    );
    expect(withRules.prompt.startsWith(FIX_DIAGNOSTIC_SYSTEM)).toBe(true);
  });

  it("reports instructionsTruncated on the result when the block was cut", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `rule ${i}`.padEnd(100, "-")).join("\n");
    const { result } = await run(long);
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") expect(result.instructionsTruncated).toBe(true);
  });
});
