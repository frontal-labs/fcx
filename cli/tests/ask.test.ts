import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECIPE_IDS } from "@fcx/recipes";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/app.js";
import { parseGlobalArgs } from "../src/args.js";
import { formatAsk, runAskCommand } from "../src/commands/ask.js";
import { exitCodeFor } from "../src/lib/recipe-runtime.js";
import { recipeEnv, stagedRepo, writeProject } from "./recipe-support.js";
import { type Sandbox, captureLog, makeSandbox, scriptedModel } from "./support.js";

describe("fcx ask", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-ask-");
    writeProject(sb.workspace, { "src/a.ts": "export const x: number = 1;\n" });
  });
  afterEach(() => sb.cleanup());

  it("routes an unsupported task to a message that lists what fcx can do, and exits 1", async () => {
    const report = await runAskCommand(
      recipeEnv(sb, scriptedModel([{ recipe: "unsupported", reason: "fcx cannot deploy." }])),
      { text: "deploy this to production" },
    );
    expect(report.status).toBe("unsupported");
    expect(exitCodeFor(report.status)).toBe(1);
    expect(report.capabilities).toHaveLength(RECIPE_IDS.length);
    const text = formatAsk(report);
    expect(text).toContain("fcx ask: unsupported");
    expect(text).toContain("fcx cannot deploy.");
    expect(text).toContain("fcx fix <file[:line]>");
  });

  it("prints the command for a routed recipe that needs inputs, and exits 0", async () => {
    const report = await runAskCommand(
      recipeEnv(sb, scriptedModel([{ recipe: "fix-test", target: "tests/a.test.ts" }])),
      { text: "fix the failing test" },
    );
    expect(report).toMatchObject({ status: "routed", route: { recipe: "fix-test" } });
    expect(report.suggestion).toContain("fcx fix-test <file>");
    expect(exitCodeFor(report.status)).toBe(0);
    const text = formatAsk(report);
    expect(text).toContain("routed to fix-test");
    expect(text).toContain("router suggested target: tests/a.test.ts");
    expect(text).toContain("run: fcx fix-test");
  });

  it("runs a commit-message route with the repository as input", async () => {
    const repo = mkdtempSync(join(tmpdir(), "fcx-ask-repo-"));
    try {
      stagedRepo(repo, "math.ts", "export const x = 1;\n");
      const model = scriptedModel([
        { recipe: "commit-message" },
        { type: "feat", subject: "add a constant" },
      ]);
      const report = await runAskCommand(recipeEnv(sb, model, { workspace: repo }), {
        text: "write a commit message",
      });
      expect(report).toMatchObject({
        command: "ask",
        recipe: "commit-message",
        status: "proposed",
      });
      expect(report.message).toBe("feat: add a constant");
      expect(exitCodeFor(report.status)).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports a router output outside the schema as an error", async () => {
    const report = await runAskCommand(recipeEnv(sb, scriptedModel([{ recipe: "nonsense" }])), {
      text: "anything",
    });
    expect(report.status).toBe("error");
    expect(report.error?.code).toBe("ROUTE_FAILED");
    expect(exitCodeFor(report.status)).toBe(1);
  });

  it("the command rejects an empty question before loading a model, in JSON", async () => {
    const args = parseGlobalArgs(["--output-format", "json", "ask"]);
    const { code, lines } = await captureLog(() => run({ ...args, cwd: sb.workspace }));
    expect(code).toBe(1);
    const report = JSON.parse(lines.join("\n"));
    expect(report).toMatchObject({ command: "ask", status: "error", error: { code: "USAGE" } });
  });
});
