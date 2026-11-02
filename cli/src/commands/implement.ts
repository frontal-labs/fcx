import { readFileSync } from "node:fs";
import { runImplement } from "@fcx/recipes";
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
  tooManyArguments,
} from "../lib/recipe-runtime.js";
import { parseFileLine } from "../lib/target.js";

export interface ImplementInput {
  file: string;
  /** 1-based line inside the stub function. */
  line: number;
}

export interface ImplementReport extends RecipeReportBase {
  replacement?: string;
}

/** `fcx implement <file:line>`: writes the body of the stub function at the line. */
export async function runImplementCommand(
  env: RecipeEnv,
  input: ImplementInput,
): Promise<ImplementReport> {
  const state = startRun(env, "implement", "implement", input.file);
  try {
    const base = readFileSync(absoluteTarget(env.workspace, input.file), "utf8");
    const result = await runImplement({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      line: input.line,
      indexPath: prepareIndexPath(env.indexPath),
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "implement"),
      instructions: state.instructions,
    });
    if (result.status === "abstained") {
      return abstainedRun(state, {
        file: input.file,
        lastError: result.lastError,
        bestCandidate: result.bestCandidate,
        candidates: result.candidates.length,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      });
    }
    return {
      ...(await applyVerified(state, result.edits, new Map([[input.file, base]]), {
        file: input.file,
        candidates: result.candidates.length,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      replacement: result.replacement,
    };
  } catch (error) {
    return failedRun(state, error);
  }
}

export function formatImplement(report: ImplementReport): string {
  return formatBase(report, `fcx implement ${report.file ?? ""}`);
}

export function runImplementCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 1, "fcx implement <file:line>");
  const parsed = extra ?? parseFileLine(args.rest[0] ?? "");
  return runRecipeCli({
    args,
    cwd,
    command: "implement",
    recipe: "implement",
    parsed: toParsed(
      typeof parsed === "string" ? parsed : { file: parsed.file, line: parsed.line },
    ),
    core: runImplementCommand,
    format: formatImplement,
  });
}
