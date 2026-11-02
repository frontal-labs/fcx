import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatCommit, runCommitCommand } from "../src/commands/commit.js";
import { askToCommit } from "../src/lib/approval.js";
import { asWarmServerRequest } from "../src/lib/client.js";
import { exitCodeFor } from "../src/lib/recipe-runtime.js";
import { git, recipeEnv, stagedRepo } from "./recipe-support.js";
import { type Sandbox, makeSandbox, scriptedModel } from "./support.js";

const FEAT = { type: "feat", scope: "math", subject: "add a sum helper" };

/** Forces stdin to report "not a terminal" for one test, so no prompt can wait for input. */
function withoutTty<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  return fn().finally(() => {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });
}

describe("fcx commit", () => {
  let sb: Sandbox;
  let repo: string;

  beforeEach(() => {
    sb = makeSandbox("fcx-commit-");
    repo = mkdtempSync(join(tmpdir(), "fcx-commit-repo-"));
  });

  afterEach(() => {
    sb.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports no-changes with exit 1 when nothing is staged, without calling the model", async () => {
    git(repo, ["init", "-q"]);
    const model = scriptedModel([]);
    const report = await runCommitCommand(recipeEnv(sb, model, { workspace: repo }), {
      apply: false,
      confirm: async () => true,
    });
    expect(report.status).toBe("no-changes");
    expect(exitCodeFor(report.status)).toBe(1);
    expect(model.prompts).toHaveLength(0);
    expect(formatCommit(report)).toContain("no staged changes");
  });

  it("prints the generated message without committing when --apply is not set", async () => {
    stagedRepo(repo, "math.ts", "export const x = 1;\n");
    const report = await runCommitCommand(
      recipeEnv(sb, scriptedModel([FEAT]), { workspace: repo }),
      {
        apply: false,
        confirm: async () => true,
      },
    );
    expect(report.status).toBe("proposed");
    expect(report.message).toBe("feat(math): add a sum helper");
    expect(formatCommit(report)).toBe("feat(math): add a sum helper");
    expect(git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).status).not.toBe(0);
  });

  it("declines --apply without a terminal and creates no commit", async () => {
    stagedRepo(repo, "math.ts", "export const x = 1;\n");
    const report = await withoutTty(() =>
      runCommitCommand(recipeEnv(sb, scriptedModel([FEAT]), { workspace: repo }), {
        apply: true,
        confirm: askToCommit,
      }),
    );
    expect(report.status).toBe("declined");
    expect(exitCodeFor(report.status)).toBe(3);
    expect(report.message).toBe("feat(math): add a sum helper");
    expect(git(repo, ["rev-parse", "--verify", "-q", "HEAD"]).status).not.toBe(0);
    expect(git(repo, ["diff", "--cached", "--name-only"]).stdout.trim()).toBe("math.ts");
  });

  it("declines --apply inside the warm server even when a terminal is present", async () => {
    stagedRepo(repo, "math.ts", "export const x = 1;\n");
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const answer = await asWarmServerRequest(() => askToCommit("feat: anything"));
      expect(answer).toBe(false);
    } finally {
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  });

  it("commits through git -F when the user confirms", async () => {
    stagedRepo(repo, "math.ts", "export const x = 1;\n");
    const report = await runCommitCommand(
      recipeEnv(sb, scriptedModel([FEAT]), { workspace: repo }),
      {
        apply: true,
        confirm: async (message) => message === "feat(math): add a sum helper",
      },
    );
    expect(report.status).toBe("applied");
    expect(report.commitSummary).toMatch(/add a sum helper/);
    expect(git(repo, ["log", "-1", "--format=%s"]).stdout.trim()).toBe(
      "feat(math): add a sum helper",
    );
    expect(exitCodeFor(report.status)).toBe(0);
  });

  it("writes the message file as text, not through a shell, so quotes survive", async () => {
    stagedRepo(repo, "math.ts", "export const x = 1;\n");
    const quoted = { type: "fix", subject: 'handle `$(rm -rf x)` and "quotes"' };
    const report = await runCommitCommand(
      recipeEnv(sb, scriptedModel([quoted]), { workspace: repo }),
      {
        apply: true,
        confirm: async () => true,
      },
    );
    expect(report.status).toBe("applied");
    expect(git(repo, ["log", "-1", "--format=%s"]).stdout.trim()).toBe(
      'fix: handle `$(rm -rf x)` and "quotes"',
    );
  });
});
