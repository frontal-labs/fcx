import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatExplain, runExplainCommand } from "../src/commands/explain.js";
import { exitCodeFor } from "../src/lib/recipe-runtime.js";
import { parseFileRange } from "../src/lib/target.js";
import { recipeEnv, writeProject } from "./recipe-support.js";
import { type Sandbox, makeSandbox, scriptedModel } from "./support.js";

const SOURCE =
  "export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n";

const ANSWER = {
  summary: "Sums a list of numbers.",
  claims: [
    {
      text: "`total` sums the list with `reduce`.",
      cites: [{ file: "src/a.ts", start: 1, end: 2 }],
    },
  ],
};

describe("parseFileRange", () => {
  it("accepts file:start-end and file:line", () => {
    expect(parseFileRange("src/a.ts:2-5")).toEqual({ file: "src/a.ts", startLine: 2, endLine: 5 });
    expect(parseFileRange("src/a.ts:7")).toEqual({ file: "src/a.ts", startLine: 7, endLine: 7 });
    expect(parseFileRange("src/a.ts:5-2")).toMatch(/invalid line range/);
    expect(parseFileRange("src/a.ts")).toMatch(/expected/);
  });
});

describe("fcx explain", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-explain-");
    writeProject(sb.workspace, { "src/a.ts": SOURCE });
  });
  afterEach(() => sb.cleanup());

  it("answers with cited claims and exits 0", async () => {
    const model = scriptedModel([ANSWER]);
    const report = await runExplainCommand(recipeEnv(sb, model), {
      file: "src/a.ts",
      startLine: 1,
      endLine: 3,
      question: "what does it do?",
    });
    expect(report).toMatchObject({
      command: "explain",
      recipe: "explain",
      status: "answered",
      dropped: 0,
    });
    expect(report.answer?.summary).toBe("Sums a list of numbers.");
    expect(report.question).toBe("what does it do?");
    expect(model.prompts[0]).toContain("what does it do?");
    expect(exitCodeFor(report.status)).toBe(0);
  });

  it("text output shows the summary and each claim with its citation", async () => {
    const report = await runExplainCommand(recipeEnv(sb, scriptedModel([ANSWER])), {
      file: "src/a.ts",
      startLine: 1,
      endLine: 3,
    });
    const text = formatExplain(report);
    expect(text).toContain("fcx explain src/a.ts: answered");
    expect(text).toContain("Sums a list of numbers.");
    expect(text).toContain("(src/a.ts:1-2)");
  });

  it("reports an invalid line range as invalid input", async () => {
    const report = await runExplainCommand(recipeEnv(sb, scriptedModel([])), {
      file: "src/a.ts",
      startLine: 1,
      endLine: 99,
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("INVALID_INPUT");
  });
});
