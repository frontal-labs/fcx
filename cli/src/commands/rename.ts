import { runRenameExtract } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  abstainedRun,
  applyVerified,
  candidateMetrics,
  failedRun,
  formatBase,
  layerLogger,
  prepareIndexPath,
  runRecipeCli,
  startRun,
  toParsed,
  tooManyArguments,
} from "../lib/recipe-runtime.js";
import { type FileLineColumnTarget, parseFileLineColumn } from "../lib/target.js";

export interface RenameInput extends FileLineColumnTarget {
  /** The new name. When omitted, the model proposes one. */
  newName?: string;
}

export interface RenameReport extends RecipeReportBase {
  symbol?: string;
  newName?: string;
  locations?: number;
  changedFiles?: string[];
}

/** `fcx rename <file:line:column> [new-name]`: renames a symbol with the TypeScript language service. */
export async function runRenameCommand(env: RecipeEnv, input: RenameInput): Promise<RenameReport> {
  const state = startRun(env, "rename", "rename-extract", input.file);
  try {
    const result = await runRenameExtract({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      line: input.line,
      column: input.column,
      newName: input.newName,
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "rename"),
      instructions: state.instructions,
    });
    const metrics = candidateMetrics(result.candidates);
    if (result.status === "abstained") {
      return {
        ...abstainedRun(state, {
          file: input.file,
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
        symbol: result.symbol,
        newName: input.newName,
      };
    }
    const edits = result.files.map((f) => ({ file: f.file, search: f.baseText, replace: f.text }));
    const bases = new Map(result.files.map((f) => [f.file, f.baseText] as const));
    return {
      ...(await applyVerified(state, edits, bases, {
        file: input.file,
        candidates: result.candidates.length,
        candidatesTried: metrics.candidatesTried,
        firstPassCandidate: metrics.firstPassCandidate,
        contextFiles: metrics.contextFiles,
        promptChars: metrics.promptChars,
        promptTokens: metrics.promptTokens,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      symbol: result.symbol,
      newName: result.newName,
      locations: result.locations,
      changedFiles: result.files.map((f) => f.file),
    };
  } catch (error) {
    return failedRun(state, error);
  }
}

export function formatRename(report: RenameReport): string {
  const extra: string[] = [];
  if (report.symbol !== undefined)
    extra.push(`  ${report.symbol} -> ${report.newName ?? "(not set)"}`);
  if (report.locations !== undefined) extra.push(`  locations: ${report.locations}`);
  if (report.changedFiles && report.changedFiles.length > 0) {
    extra.push(`  files: ${report.changedFiles.join(", ")}`);
  }
  return formatBase(report, `fcx rename ${report.file ?? ""}`, extra);
}

export function runRenameCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 2, "fcx rename <file:line:column> [new-name]");
  const target = parseFileLineColumn(args.rest[0] ?? "");
  const parsed =
    extra ?? (typeof target === "string" ? target : { ...target, newName: args.rest[1] });
  return runRecipeCli({
    args,
    cwd,
    command: "rename",
    recipe: "rename-extract",
    parsed: toParsed(parsed),
    core: runRenameCommand,
    format: formatRename,
  });
}
