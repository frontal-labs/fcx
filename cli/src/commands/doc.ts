import { readFileSync } from "node:fs";
import { runDocstring } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  absoluteTarget,
  abstainedRun,
  applyVerified,
  candidateMetrics,
  failedRun,
  formatBase,
  layerLogger,
  runRecipeCli,
  startRun,
  toParsed,
  tooManyArguments,
} from "../lib/recipe-runtime.js";
import { parseFileLine } from "../lib/target.js";

export interface DocInput {
  file: string;
  /** 1-based line inside the declaration to document. */
  line: number;
}

export interface DocReport extends RecipeReportBase {
  doc?: string;
}

/** `fcx doc <file:line>`: inserts a doc comment above the declaration at the line. */
export async function runDocCommand(env: RecipeEnv, input: DocInput): Promise<DocReport> {
  const state = startRun(env, "doc", "docstring", input.file);
  try {
    // The recipe verifies its edit against the text with the doc block inserted, so the base is the file on disk.
    const base = readFileSync(absoluteTarget(env.workspace, input.file), "utf8");
    const result = await runDocstring({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      line: input.line,
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "doc"),
      instructions: state.instructions,
    });
    const metrics = candidateMetrics(result.candidates);
    if (result.status === "abstained") {
      return abstainedRun(state, {
        file: input.file,
        lastError: result.lastError,
        bestCandidate: result.bestCandidate,
        candidates: result.candidates.length,
        candidatesTried: metrics.candidatesTried,
        firstPassCandidate: metrics.firstPassCandidate,
        abstainedReason: result.lastError,
        contextFiles: metrics.contextFiles,
        promptChars: metrics.promptChars,
        promptTokens: metrics.promptTokens,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      });
    }
    return {
      ...(await applyVerified(state, result.edits, new Map([[input.file, base]]), {
        file: result.file,
        candidates: result.candidates.length,
        candidatesTried: metrics.candidatesTried,
        firstPassCandidate: metrics.firstPassCandidate,
        contextFiles: metrics.contextFiles,
        promptChars: metrics.promptChars,
        promptTokens: metrics.promptTokens,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      doc: result.doc,
    };
  } catch (error) {
    return failedRun(state, error);
  }
}

export function formatDoc(report: DocReport): string {
  const extra = report.doc ? [`  ${report.doc.split("\n").join("\n  ")}`] : [];
  return formatBase(report, `fcx doc ${report.file ?? ""}`, extra);
}

export function runDocCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 1, "fcx doc <file:line>");
  const parsed = extra ?? parseFileLine(args.rest[0] ?? "");
  return runRecipeCli({
    args,
    cwd,
    command: "doc",
    recipe: "docstring",
    parsed: toParsed(
      typeof parsed === "string" ? parsed : { file: parsed.file, line: parsed.line },
    ),
    core: runDocCommand,
    format: formatDoc,
  });
}
