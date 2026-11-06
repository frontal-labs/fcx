import type { Edit } from "@fcx/apply";
import { type CreateResult, runCreate } from "@fcx/recipes";
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

export interface CreateInput {
  /** Workspace-relative path of the new file. */
  file: string;
  /** What the file should contain. */
  description: string;
}

export interface CreateReport extends RecipeReportBase {
  file?: string;
  code?: string;
}

/** `fcx create <file> "<description>"`: creates a new file with AI-generated content. */
export async function runCreateCommand(env: RecipeEnv, input: CreateInput): Promise<CreateReport> {
  const state = startRun(env, "create", "create", input.file);
  const extra = { file: input.file };
  let result: CreateResult;
  try {
    result = await runCreate({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      description: input.description,
      indexPath: prepareIndexPath(env.indexPath),
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "create"),
      instructions: state.instructions,
    });
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }

  const metrics = candidateMetrics(result.candidates);
  if (result.status === "abstained") {
    return {
      ...abstainedRun(state, {
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
      }),
      ...extra,
    };
  }

  // A new file has no prior content; its base is the empty string.
  const edits: Edit[] = [{ file: result.file, search: "", replace: result.code }];
  const bases = new Map<string, string>([[result.file, ""]]);
  return {
    ...(await applyVerified(state, edits, bases, {
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
    ...extra,
    code: result.code,
  } as CreateReport;
}

export function formatCreate(report: CreateReport): string {
  const extra: string[] = [];
  if (report.file) extra.push(`  new file: ${report.file}`);
  if (report.code) extra.push(`  ${report.code.split("\n").join("\n  ")}`);
  return formatBase(report, `fcx create ${report.file ?? ""}`, extra);
}

/** Parses `file "<description>"` for the CLI. Returns the input or a usage message. */
export function parseCreateTarget(argv: readonly string[]): CreateInput | string {
  if (argv.length < 2) return 'usage: fcx create <file> "<description>"';
  const file = argv[0];
  let description = argv.slice(1).join(" ");
  if (description.startsWith('"') && description.endsWith('"')) {
    description = description.slice(1, -1);
  }
  if (!file || !description) return 'usage: fcx create <file> "<description>"';
  return { file, description };
}

export function runCreateCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 2, 'fcx create <file> "<description>"');
  return runRecipeCli({
    args,
    cwd,
    command: "create",
    recipe: "create",
    parsed: toParsed(extra ?? parseCreateTarget(args.rest)),
    core: runCreateCommand,
    format: formatCreate,
  });
}
