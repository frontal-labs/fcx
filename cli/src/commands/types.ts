import { readFileSync } from "node:fs";
import { runAddTypes } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  absoluteTarget,
  abstainedRun,
  applyVerified,
  completeRun,
  failedRun,
  formatBase,
  layerLogger,
  prepareIndexPath,
  runRecipeCli,
  startRun,
  toParsed,
  tooManyArguments,
} from "../lib/recipe-runtime.js";
import { parseFileSymbol } from "../lib/target.js";

export interface TypesInput {
  file: string;
  /** A declaration name. When omitted, the whole file is annotated. */
  symbol?: string;
}

export interface TypesReport extends RecipeReportBase {
  symbol?: string;
  annotated?: string[];
}

/** `fcx types <file[:symbol]>`: adds missing type annotations. TypeScript files only. */
export async function runTypesCommand(env: RecipeEnv, input: TypesInput): Promise<TypesReport> {
  const state = startRun(env, "types", "add-types", input.file);
  const extra = { symbol: input.symbol };
  try {
    const abs = absoluteTarget(env.workspace, input.file);
    // The text on disk before the run is the base the edits apply to. The recipe's returned text is the edited one.
    const base = readFileSync(abs, "utf8");
    const lineCount = base.split("\n").length;
    const result = await runAddTypes({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      symbol: input.symbol,
      startLine: input.symbol === undefined ? 1 : undefined,
      endLine: input.symbol === undefined ? lineCount : undefined,
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "types"),
      instructions: state.instructions,
    });
    if (result.status === "nothing-to-annotate") {
      return {
        ...completeRun(state, { status: "nothing-to-annotate", file: result.file }),
        ...extra,
        annotated: [],
      };
    }
    if (result.status === "abstained") {
      return {
        ...abstainedRun(state, {
          file: result.file,
          lastError: result.lastError,
          bestCandidate: result.bestCandidate,
          candidates: result.candidates.length,
          scope: result.verification,
          instructionsTruncated: result.instructionsTruncated,
        }),
        ...extra,
        annotated: result.annotated,
      };
    }
    return {
      ...(await applyVerified(state, result.edits, new Map([[result.file, base]]), {
        file: result.file,
        candidates: result.candidates.length,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      ...extra,
      annotated: result.annotated,
    };
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }
}

export function formatTypes(report: TypesReport): string {
  const target = `${report.file ?? ""}${report.symbol ? `:${report.symbol}` : ""}`;
  const extra: string[] = [];
  if (report.annotated && report.annotated.length > 0) {
    extra.push(`  annotated: ${report.annotated.join(", ")}`);
  }
  return formatBase(report, `fcx types ${target}`, extra);
}

export function runTypesCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 1, "fcx types <file[:symbol]>");
  const parsed = extra ?? parseFileSymbol(args.rest[0] ?? "");
  return runRecipeCli({
    args,
    cwd,
    command: "types",
    recipe: "add-types",
    parsed: toParsed(
      typeof parsed === "string" ? parsed : { file: parsed.file, symbol: parsed.symbol },
    ),
    core: runTypesCommand,
    format: formatTypes,
  });
}
