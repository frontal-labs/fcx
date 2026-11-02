import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FixCommandOptions, exitCodeFor, runFixCommand } from "../src/commands/fix.js";
import { undoRootFor } from "../src/lib/repo.js";
import { applyUndo } from "../src/lib/undo.js";

const SOURCE = `export function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export const label: string = total([1, 2]);
`;

/** A model stand-in that returns queued outputs and records every prompt it was sent. */
function scriptedModel(outputs: unknown[]) {
  const prompts: string[] = [];
  const model = {
    prompts,
    generateObject: async <T>(req: { prompt: string }) => {
      prompts.push(req.prompt);
      const object = outputs.shift();
      if (object === undefined) throw new Error("scripted model ran out of outputs");
      return { object: object as T, ms: 1, raw: JSON.stringify(object) };
    },
  };
  return model;
}

const GOOD_EDIT = {
  edits: [
    {
      file: "src/a.ts",
      search: "export const label: string = total([1, 2]);",
      replace: "export const label: string = String(total([1, 2]));",
    },
  ],
};

describe("fcx fix end to end (TypeScript project, real checker and apply)", () => {
  let workspace: string;
  let cache: string;
  let options: Omit<FixCommandOptions, "model" | "target">;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "fcx-fix-"));
    cache = join(workspace, ".cache");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "bundler",
          noEmit: true,
        },
        include: ["src"],
      }),
    );
    writeFileSync(join(workspace, "src", "a.ts"), SOURCE);
    options = {
      workspace,
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 4,
      approve: async () => false,
      undoRoot: undoRootFor(cache, workspace),
      logsDir: join(cache, "logs"),
    };
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const read = () => readFileSync(join(workspace, "src", "a.ts"), "utf-8");

  it("applies a verified fix, and undo restores the original file", async () => {
    const model = scriptedModel([GOOD_EDIT]);
    const report = await runFixCommand({ ...options, model, target: "src/a.ts:5" });

    expect(report.status).toBe("applied");
    expect(report.diagnostic).toMatchObject({ code: 2322, line: 5 });
    expect(read()).toContain("String(total([1, 2]))");
    expect(report.undoId).toBeTruthy();
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.layers.map((l) => [l.layer, l.pass])).toEqual([
      ["constrain", true],
      ["anchor", true],
      ["verify", true],
    ]);
    expect(exitCodeFor(report.status)).toBe(0);

    const undone = applyUndo(cache, workspace);
    expect(undone.status).toBe("ok");
    expect(read()).toBe(SOURCE);

    expect(applyUndo(cache, workspace).status).toBe("error");
  });

  it("fixes a missing import from the compiler's quick fix, without calling the model", async () => {
    writeFileSync(
      join(workspace, "src", "helper.ts"),
      "export function helper(): number {\n  return 1;\n}\n",
    );
    writeFileSync(join(workspace, "src", "a.ts"), "export const value: number = helper();\n");

    const model = scriptedModel([]);
    const report = await runFixCommand({ ...options, model, target: "src/a.ts:1" });

    expect(report.status).toBe("applied");
    expect(report.candidates[0]?.source).toBe("compiler");
    expect(model.prompts).toHaveLength(0);
    expect(read()).toMatch(/import \{ helper \} from "\.\/helper(\.js)?";/);
    expect(read()).toContain("export const value: number = helper();");
  });

  it("counts duplicate errors, so fixing one of two identical errors is accepted", async () => {
    writeFileSync(
      join(workspace, "src", "a.ts"),
      'export const a: number = "x";\nexport const b = 1;\nexport const c: number = "x";\n',
    );
    const fixFirst = {
      edits: [
        {
          file: "src/a.ts",
          search: 'export const a: number = "x";',
          replace: "export const a: number = 1;",
        },
      ],
    };
    const report = await runFixCommand({
      ...options,
      model: scriptedModel([fixFirst]),
      target: "src/a.ts:1",
    });

    expect(report.status).toBe("applied");
    expect(read()).toContain("export const a: number = 1;");
    expect(read()).toContain('export const c: number = "x";');
  });

  it("retries after a rejected anchor and feeds the failure into the next prompt", async () => {
    const badAnchor = {
      edits: [
        { file: "src/a.ts", search: "export const label: string = total([9]);", replace: "x" },
      ],
    };
    const model = scriptedModel([badAnchor, GOOD_EDIT]);
    const report = await runFixCommand({ ...options, model, target: "src/a.ts" });

    expect(report.status).toBe("applied");
    expect(report.candidates).toHaveLength(2);
    expect(report.candidates[0]?.layers.at(-1)).toMatchObject({
      layer: "anchor",
      pass: false,
      reasonCode: "ANCHOR_NOT_FOUND",
    });
    expect(model.prompts[1]).toContain("Your previous attempt was rejected");
    expect(model.prompts[1]).toContain("does not match the file exactly");
  });

  it("abstains and writes nothing when no candidate passes verification", async () => {
    // Introduces a new error (unknown identifier) and never fixes the original one.
    const breaking = {
      edits: [{ file: "src/a.ts", search: "total([1, 2])", replace: "totl([1, 2])" }],
    };
    const model = scriptedModel([breaking, breaking]);
    const report = await runFixCommand({
      ...options,
      model,
      target: "src/a.ts:5",
      maxCandidates: 2,
    });

    expect(report.status).toBe("abstained");
    expect(report.lastError).toMatch(/introduced a new error|still present/);
    expect(report.edits).toEqual(breaking.edits);
    expect(read()).toBe(SOURCE);
    expect(exitCodeFor(report.status)).toBe(2);
  });

  it("proposes without writing in read-only mode", async () => {
    const report = await runFixCommand({
      ...options,
      permissionMode: "read-only",
      model: scriptedModel([GOOD_EDIT]),
      target: "src/a.ts:5",
    });
    expect(report.status).toBe("proposed");
    expect(report.edits).toEqual(GOOD_EDIT.edits);
    expect(read()).toBe(SOURCE);
  });

  it("declines in prompt mode when the user does not approve", async () => {
    const report = await runFixCommand({
      ...options,
      permissionMode: "prompt",
      approve: async () => false,
      model: scriptedModel([GOOD_EDIT]),
      target: "src/a.ts:5",
    });
    expect(report.status).toBe("declined");
    expect(exitCodeFor(report.status)).toBe(3);
    expect(read()).toBe(SOURCE);
  });

  it("applies in prompt mode when the user approves", async () => {
    const report = await runFixCommand({
      ...options,
      permissionMode: "prompt",
      approve: async () => true,
      model: scriptedModel([GOOD_EDIT]),
      target: "src/a.ts:5",
    });
    expect(report.status).toBe("applied");
    expect(read()).toContain("String(total");
  });

  it("reports no-diagnostics for a clean line range, without calling the model", async () => {
    const model = scriptedModel([]);
    const report = await runFixCommand({ ...options, model, target: "src/a.ts:1" });
    expect(report.status).toBe("no-diagnostics");
    expect(model.prompts).toHaveLength(0);
  });

  it("reports a model that cannot load as an error with a hint, not as abstention", async () => {
    const unloadable = {
      generateObject: async () => {
        throw Object.assign(new Error("Failed to load generation model qwen2.5-1.5b"), {
          code: "MODEL_LOAD_ERROR",
          hint: "run: npx ggml-node pull qwen2.5-1.5b",
        });
      },
    };
    const report = await runFixCommand({ ...options, model: unloadable, target: "src/a.ts:5" });
    expect(report.status).toBe("error");
    expect(report.error).toMatchObject({
      code: "FIX_FAILED",
      hint: "run: npx ggml-node pull qwen2.5-1.5b",
    });
    expect(read()).toBe(SOURCE);
  });

  it("refuses paths outside the workspace", async () => {
    const report = await runFixCommand({
      ...options,
      model: scriptedModel([]),
      target: "../outside.ts",
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects a malformed target", async () => {
    const report = await runFixCommand({
      ...options,
      model: scriptedModel([]),
      target: "src/a.ts:0",
    });
    expect(report.error?.code).toBe("INVALID_TARGET");
  });

  it("refuses to undo when the file changed after fcx applied the fix", async () => {
    const report = await runFixCommand({
      ...options,
      model: scriptedModel([GOOD_EDIT]),
      target: "src/a.ts:5",
    });
    expect(report.status).toBe("applied");
    writeFileSync(join(workspace, "src", "a.ts"), `${read()}\n// user edit\n`);

    const undone = applyUndo(cache, workspace);
    expect(undone.status).toBe("error");
    expect(undone.status === "error" && undone.message).toMatch(/changed since fcx applied it/);
  });
});
