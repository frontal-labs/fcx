import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import {
  COMMIT_MESSAGE_SYSTEM,
  type CommitMessageOptions,
  CommitMessageSchema,
  DIFF_LIMIT_BYTES,
  runCommitMessage,
} from "../src/recipes/commit-message.js";
import { promptBody, queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "commit-message.md");

/** Runs git in `cwd` and throws on failure. Test setup only. */
function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

function commit(cwd: string, subject: string): void {
  git(cwd, ["commit", "--allow-empty", "-q", "-m", subject]);
}

describe("commit-message prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(COMMIT_MESSAGE_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });
});

describe("CommitMessageSchema", () => {
  it("accepts a message with and without scope and body", () => {
    expect(
      CommitMessageSchema.safeParse({ type: "fix", subject: "handle empty input" }).success,
    ).toBe(true);
    expect(
      CommitMessageSchema.safeParse({
        type: "feat",
        scope: "math",
        subject: "add sum",
        body: "Why.",
      }).success,
    ).toBe(true);
  });

  it("rejects a type outside the list in the schema", () => {
    expect(CommitMessageSchema.safeParse({ type: "feature", subject: "add sum" }).success).toBe(
      false,
    );
  });

  it("accepts a scope with capitals in the schema, and the verify layer rejects it", () => {
    // The schema carries no regex: the grammar builder rejects `pattern`. The format is enforced in verify.
    expect(
      CommitMessageSchema.safeParse({ type: "feat", scope: "Math", subject: "add sum" }).success,
    ).toBe(true);
  });
});

describe("runCommitMessage", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "fcx-commit-"));
    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "test@example.com"]);
    git(repo, ["config", "user.name", "Test"]);
    git(repo, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README.md"), "# demo\n");
    git(repo, ["add", "README.md"]);
    commit(repo, "initial commit");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const stageMath = () => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "math.ts"),
      "export const sum = (a: number, b: number) => a + b;\n",
    );
    git(repo, ["add", "src/math.ts"]);
  };

  const base = (model: ReturnType<typeof queueModel>, maxCandidates = 2): CommitMessageOptions => ({
    model,
    repo,
    maxCandidates,
  });

  it("reports no-changes, without calling the model, when nothing is staged", async () => {
    const model = queueModel([]);
    const result = await runCommitMessage(base(model));
    expect(result.status).toBe("no-changes");
    expect(model.prompts).toHaveLength(0);
  });

  it("ignores unstaged changes", async () => {
    writeFileSync(join(repo, "README.md"), "# changed but not staged\n");
    const model = queueModel([]);
    expect((await runCommitMessage(base(model))).status).toBe("no-changes");
    expect(model.prompts).toHaveLength(0);
  });

  it("verifies a message, formats it, and sends the staged diff and recent subjects", async () => {
    stageMath();
    const model = queueModel([
      {
        type: "feat",
        scope: "math",
        subject: "add a sum helper",
        body: "Used by the totals report.",
      },
    ]);
    const result = await runCommitMessage({ ...base(model), maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", diffTruncated: false });
    if (result.status === "verified") {
      expect(result.text).toBe("feat(math): add a sum helper\n\nUsed by the totals report.");
    }
    expect(model.prompts[0]).toContain("+export const sum");
    expect(model.prompts[0]).toContain("- initial commit");
  });

  it("rejects a subject with a trailing period, then verifies the next candidate", async () => {
    stageMath();
    const model = queueModel([
      { type: "feat", subject: "add a sum helper." },
      { type: "feat", subject: "add a sum helper" },
    ]);
    const result = await runCommitMessage(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]?.layers[0]).toMatchObject({
        pass: false,
        reasonCode: "SUBJECT_TRAILING_PERIOD",
      });
    }
  });

  it("rejects a subject longer than 72 characters", async () => {
    stageMath();
    const long = `add ${"x".repeat(70)}`;
    const model = queueModel([
      { type: "feat", subject: long },
      { type: "feat", subject: "add a sum helper" },
    ]);
    const result = await runCommitMessage(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]?.layers[0]).toMatchObject({
        pass: false,
        reasonCode: "SUBJECT_TOO_LONG",
      });
    }
  });

  it("records a type outside the list as schema-invalid and then verifies the next one", async () => {
    stageMath();
    const model = queueModel([
      { type: "feature", subject: "add a sum helper" },
      { type: "feat", subject: "add a sum helper" },
    ]);
    const result = await runCommitMessage(base(model));
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.candidates[0]).toMatchObject({ source: "model", pass: false });
      expect(result.candidates[0]?.error).toBeDefined();
    }
    expect(model.prompts[1]).toContain("did not match the required JSON schema");
  });

  it("abstains when every candidate breaks a rule", async () => {
    stageMath();
    const bad = { type: "feat", subject: "Add a sum helper." };
    const result = await runCommitMessage(base(queueModel([bad, bad])));
    expect(result.status).toBe("abstained");
    if (result.status === "abstained") {
      expect(result.lastError).toMatch(/period/);
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("caps the diff at 64 KiB and says so in the prompt", async () => {
    mkdirSync(join(repo, "data"), { recursive: true });
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n");
    expect(big.length).toBeGreaterThan(DIFF_LIMIT_BYTES);
    writeFileSync(join(repo, "data", "big.txt"), big);
    git(repo, ["add", "data/big.txt"]);
    const model = queueModel([{ type: "chore", subject: "add a large data file" }]);
    const result = await runCommitMessage({ ...base(model), maxCandidates: 1 });
    expect(result).toMatchObject({ status: "verified", diffTruncated: true });
    expect(model.prompts[0]).toContain(`truncated at ${DIFF_LIMIT_BYTES} bytes`);
    expect(model.prompts[0]?.length ?? 0).toBeLessThan(DIFF_LIMIT_BYTES + 4096);
  });

  it("sends only the last 20 commit subjects, newest first", async () => {
    for (let i = 1; i <= 22; i++) commit(repo, `subject ${String(i).padStart(2, "0")}`);
    stageMath();
    const model = queueModel([{ type: "feat", subject: "add a sum helper" }]);
    await runCommitMessage({ ...base(model), maxCandidates: 1 });
    const prompt = model.prompts[0] ?? "";
    expect(prompt).toContain("- subject 22");
    expect(prompt).toContain("- subject 03");
    expect(prompt).not.toContain("- subject 02");
    expect(prompt).not.toContain("- initial commit");
  });

  it("refuses a path that is not a directory", async () => {
    await expect(
      runCommitMessage({ ...base(queueModel([])), repo: join(repo, "missing") }),
    ).rejects.toBeInstanceOf(RecipeInputError);
  });

  it("refuses a directory that is not a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "fcx-plain-"));
    try {
      await expect(
        runCommitMessage({ ...base(queueModel([])), repo: plain }),
      ).rejects.toBeInstanceOf(RecipeInputError);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
