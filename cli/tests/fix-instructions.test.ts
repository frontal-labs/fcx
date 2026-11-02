import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFixCommand } from "../src/commands/fix.js";
import { undoRootFor } from "../src/lib/repo.js";
import { writeProject } from "./recipe-support.js";
import { type Sandbox, makeSandbox, scriptedModel } from "./support.js";

const SOURCE =
  "export function total(xs: number[]): number {\n  return xs.reduce((a, b) => a + b, 0);\n}\n\nexport const label: string = total([1, 2]);\n";
const GOOD = {
  edits: [
    {
      file: "src/a.ts",
      search: "export const label: string = total([1, 2]);",
      replace: "export const label: string = String(total([1, 2]));",
    },
  ],
};

describe("fcx fix passes project instructions", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-fixins-");
    writeProject(sb.workspace, { "src/a.ts": SOURCE });
    writeFileSync(join(sb.workspace, "AGENTS.md"), "# Rules\n\nUse String() for numeric labels.\n");
  });
  afterEach(() => sb.cleanup());

  it("sends the AGENTS.md text in the prompt and reports it", async () => {
    const model = scriptedModel([GOOD]);
    const report = await runFixCommand({
      workspace: sb.workspace,
      target: "src/a.ts:5",
      permissionMode: "read-only",
      dryRun: true,
      maxCandidates: 1,
      model,
      approve: async () => false,
      undoRoot: undoRootFor(sb.cache, sb.workspace),
      logsDir: join(sb.cache, "logs"),
    });
    expect(report.status).toBe("proposed");
    expect(report.instructions).toContain("Use String() for numeric labels.");
    expect(model.prompts[0]).toContain("Use String() for numeric labels.");
  });
});
