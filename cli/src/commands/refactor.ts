import { readFileSync } from "node:fs";
import { runRefactorSmall } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  absoluteTarget,
  abstainedRun,
  applyVerified,
  failedRun,
  formatBase,
  layerLogger,
  prepareIndexPath,
  runRecipeCli,
  startRun,
  toParsed,
} from "../lib/recipe-runtime.js";
import { type FileRangeTarget, parseFileRange } from "../lib/target.js";

export interface RefactorInput extends FileRangeTarget {
  instruction: string;
}

export interface RefactorReport extends RecipeReportBase {
  instruction?: string;
  allowedFiles?: string[];
}

/** `fcx refactor <file:start-end> "<instruction>"`: a small refactor of a selected range. */
export async function runRefactorCommand(
  env: RecipeEnv,
  input: RefactorInput,
): Promise<RefactorReport> {
  const state = startRun(env, "refactor", "refactor-small", input.file);
  const extra = { instruction: input.instruction };
  try {
    const base = readFileSync(absoluteTarget(env.workspace, input.file), "utf8");
    const result = await runRefactorSmall({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      startLine: input.startLine,
      endLine: input.endLine,
      instruction: input.instruction,
      indexPath: prepareIndexPath(env.indexPath),
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "refactor"),
      instructions: state.instructions,
    });
    if (result.status === "abstained") {
      return {
        ...abstainedRun(state, {
          file: input.file,
          lastError: result.lastError,
          bestCandidate: result.bestCandidate,
          candidates: result.candidates.length,
          scope: result.verification,
          instructionsTruncated: result.instructionsTruncated,
        }),
        ...extra,
        allowedFiles: result.allowedFiles,
      };
    }
    // The selection's file is verified against the text read here. Caller files are read when the plan is made.
    return {
      ...(await applyVerified(state, result.edits, new Map([[input.file, base]]), {
        file: input.file,
        candidates: result.candidates.length,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      ...extra,
      allowedFiles: result.allowedFiles,
    };
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }
}

export function formatRefactor(report: RefactorReport): string {
  const extra = report.allowedFiles
    ? [`  files the edits may touch: ${report.allowedFiles.join(", ")}`]
    : [];
  return formatBase(report, `fcx refactor ${report.file ?? ""}`, extra);
}

export function runRefactorCli(args: GlobalArgs, cwd: string): Promise<number> {
  const [target, ...instruction] = args.rest;
  const range = parseFileRange(target ?? "");
  const text = instruction.join(" ").trim();
  const parsed =
    typeof range === "string"
      ? range
      : text === ""
        ? 'usage: fcx refactor <file:start-end> "<instruction>"'
        : { ...range, instruction: text };
  return runRecipeCli({
    args,
    cwd,
    command: "refactor",
    recipe: "refactor-small",
    parsed: toParsed(parsed),
    core: runRefactorCommand,
    format: formatRefactor,
  });
}
