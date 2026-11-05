import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommitMessage } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import { askToCommit } from "../lib/approval.js";
import { parseCommandArgs } from "../lib/command-args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  abstainedRun,
  candidateMetrics,
  completeRun,
  failedRun,
  formatBase,
  layerLogger,
  runRecipeCli,
  startRun,
  toParsed,
} from "../lib/recipe-runtime.js";

export interface CommitInput {
  /** Run `git commit` after `confirm` returns true. */
  apply: boolean;
  /** Asked only with `apply`. Returns true to commit. Declines are the default. */
  confirm: (message: string) => Promise<boolean>;
}

export interface CommitReport extends RecipeReportBase {
  apply?: boolean;
  /** The generated message, as git would store it. */
  message?: string;
  /** The first line git printed after a commit, such as `[main abc1234] feat: ...`. */
  commitSummary?: string;
}

/**
 * `fcx commit [--apply]`: writes a commit message for the staged changes. With `apply`, runs `git commit -F` after
 * confirmation. The message goes through a temporary file and argv, never a shell string.
 */
export async function runCommitCommand(env: RecipeEnv, input: CommitInput): Promise<CommitReport> {
  const state = startRun(env, "commit", "commit-message");
  const extra = { apply: input.apply };
  try {
    const result = await runCommitMessage({
      model: env.model,
      repo: env.workspace,
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "commit"),
      instructions: state.instructions,
    });
    if (result.status === "no-changes") {
      return {
        ...completeRun(state, { status: "no-changes" }),
        ...extra,
      };
    }
    const metrics = candidateMetrics(result.candidates);
    if (result.status === "abstained") {
      if (result.diffTruncated) state.warnings.push("the staged diff was cut to its size limit");
      return {
        ...abstainedRun(state, {
          lastError: result.lastError,
          candidates: result.candidates.length,
          candidatesTried: metrics.candidatesTried,
          firstPassCandidate: metrics.firstPassCandidate,
          abstainedReason: result.lastError,
          contextFiles: metrics.contextFiles,
          promptChars: metrics.promptChars,
          promptTokens: metrics.promptTokens,
          scope: result.verification,
          instructionsTruncated: result.instructionsTruncated,
        }),
        ...extra,
      };
    }
    if (result.diffTruncated) state.warnings.push("the staged diff was cut to its size limit");
    const body = {
      candidates: result.candidates.length,
      candidatesTried: metrics.candidatesTried,
      firstPassCandidate: metrics.firstPassCandidate,
      contextFiles: metrics.contextFiles,
      promptChars: metrics.promptChars,
      promptTokens: metrics.promptTokens,
      scope: result.verification,
      instructionsTruncated: result.instructionsTruncated,
    };
    if (!input.apply) {
      return {
        ...completeRun(state, { ...body, status: "proposed" }),
        ...extra,
        message: result.text,
      };
    }
    if (!(await input.confirm(result.text))) {
      return {
        ...completeRun(state, { ...body, status: "declined" }),
        ...extra,
        message: result.text,
      };
    }
    const committed = gitCommit(env.workspace, result.text);
    if (!committed.ok) {
      return {
        ...failedRun(state, new Error(committed.message), "COMMIT_FAILED"),
        ...extra,
        message: result.text,
      };
    }
    return {
      ...completeRun(state, { ...body, status: "applied" }),
      ...extra,
      message: result.text,
      commitSummary: committed.summary,
    };
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }
}

/** Runs `git commit -F <tempfile>` in the repository. Argv only, never a shell string. */
export function gitCommit(
  repo: string,
  text: string,
): { ok: true; summary: string } | { ok: false; message: string } {
  const dir = mkdtempSync(join(tmpdir(), "fcx-commit-"));
  const file = join(dir, "COMMIT_EDITMSG");
  try {
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    const result = spawnSync("git", ["commit", "-F", file], { cwd: repo, encoding: "utf8" });
    if (result.error) return { ok: false, message: result.error.message };
    if (result.status !== 0) {
      const detail = `${result.stderr}${result.stdout}`.trim();
      return { ok: false, message: detail || `git commit exited with status ${result.status}` };
    }
    return { ok: true, summary: result.stdout.split("\n")[0] ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatCommit(report: CommitReport): string {
  if (report.status === "proposed" && report.message !== undefined) {
    const warnings = report.warnings.map((w) => `warning: ${w}\n`).join("");
    return `${report.message}\n${warnings}`.trimEnd();
  }
  const extra: string[] = [];
  if (report.status === "no-changes")
    extra.push("  no staged changes. stage files with git add first");
  if (report.message !== undefined && report.status !== "applied") {
    extra.push(`  ${report.message.split("\n").join("\n  ")}`);
  }
  if (report.commitSummary) extra.push(`  ${report.commitSummary}`);
  if (report.status === "declined")
    extra.push("  not committed. --apply needs an interactive terminal and a yes");
  return formatBase(report, "fcx commit", extra);
}

export function runCommitCli(args: GlobalArgs, cwd: string): Promise<number> {
  const parsed = parseCommandArgs(args.rest, { values: [], flags: ["--apply"] });
  const input =
    typeof parsed === "string"
      ? parsed
      : parsed.positionals.length > 0
        ? `fcx commit takes no arguments except --apply, got: ${parsed.positionals.join(" ")}`
        : { apply: parsed.flags.has("--apply"), confirm: askToCommit };
  return runRecipeCli({
    args,
    cwd,
    command: "commit",
    recipe: "commit-message",
    parsed: toParsed(input),
    core: runCommitCommand,
    format: formatCommit,
  });
}
