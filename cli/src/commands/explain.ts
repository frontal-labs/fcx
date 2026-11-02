import { type ExplainAnswer, runExplain } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  abstainedRun,
  completeRun,
  failedRun,
  formatBase,
  layerLogger,
  runRecipeCli,
  startRun,
  toParsed,
} from "../lib/recipe-runtime.js";
import { type FileRangeTarget, parseFileRange } from "../lib/target.js";

export interface ExplainInput extends FileRangeTarget {
  question?: string;
}

export interface ExplainReport extends RecipeReportBase {
  answer?: ExplainAnswer;
  /** Claims the defense layer removed because their citations did not support them. */
  dropped?: number;
  question?: string;
}

/** `fcx explain <file:start-end> [question]`: explains a selection or answers a question about it. */
export async function runExplainCommand(
  env: RecipeEnv,
  input: ExplainInput,
): Promise<ExplainReport> {
  const state = startRun(env, "explain", "explain", input.file);
  const extra = { question: input.question };
  try {
    const result = await runExplain({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      startLine: input.startLine,
      endLine: input.endLine,
      question: input.question,
      onLayer: layerLogger(env.logsDir, "explain"),
      instructions: state.instructions,
    });
    if (result.status === "abstained") {
      return {
        ...abstainedRun(state, {
          file: input.file,
          lastError: result.lastError,
          candidates: result.attempts,
          scope: result.verification,
          instructionsTruncated: result.instructionsTruncated,
        }),
        ...extra,
        answer: result.answer,
        dropped: result.dropped.length,
      };
    }
    return {
      ...completeRun(state, {
        status: "answered",
        file: input.file,
        candidates: result.attempts,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      }),
      ...extra,
      answer: result.answer,
      dropped: result.dropped.length,
    };
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }
}

export function formatExplain(report: ExplainReport): string {
  const extra: string[] = [];
  if (report.answer) {
    extra.push(`  ${report.answer.summary}`);
    for (const claim of report.answer.claims) {
      const cite = claim.cites[0];
      const where = cite ? ` (${cite.file}:${cite.start}-${cite.end})` : "";
      extra.push(`  - ${claim.text}${where}`);
    }
  }
  if (report.dropped) extra.push(`  dropped ${report.dropped} claim(s) without support`);
  return formatBase(report, `fcx explain ${report.file ?? ""}`, extra);
}

export function runExplainCli(args: GlobalArgs, cwd: string): Promise<number> {
  const [target, ...question] = args.rest;
  const range = parseFileRange(target ?? "");
  const text = question.join(" ").trim();
  const parsed =
    typeof range === "string" ? range : { ...range, question: text === "" ? undefined : text };
  return runRecipeCli({
    args,
    cwd,
    command: "explain",
    recipe: "explain",
    parsed: toParsed(parsed),
    core: runExplainCommand,
    format: formatExplain,
  });
}
