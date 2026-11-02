import { type WriteTestResult, runWriteTest } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  abstainedRun,
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
import { parseFileSymbolRequired } from "../lib/target.js";

export interface WriteTestInput {
  /** Workspace file that declares the symbol. */
  file: string;
  symbol: string;
}

export interface WriteTestReport extends RecipeReportBase {
  /** The file that declares the symbol, as given. `file` is the proposed test file. */
  source?: string;
  symbol?: string;
  testCode?: string;
  imports?: string[];
}

/** `fcx test <file:symbol>`: writes a unit test for one symbol. The test file is proposed, never written. */
export async function runWriteTestCommand(
  env: RecipeEnv,
  input: WriteTestInput,
): Promise<WriteTestReport> {
  const state = startRun(env, "test", "write-test", input.file);
  const extra = { source: input.file, symbol: input.symbol };
  let result: WriteTestResult;
  try {
    result = await runWriteTest({
      model: env.model,
      workspace: env.workspace,
      file: input.file,
      symbol: input.symbol,
      indexPath: prepareIndexPath(env.indexPath),
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "test"),
      instructions: state.instructions,
    });
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }

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
    };
  }
  // @fcx/apply edits existing files only, so the new test file is reported and never written.
  state.warnings.push("the test file is not written: fcx does not create new files yet");
  return {
    ...completeRun(state, {
      status: "proposed",
      file: result.file,
      candidates: result.candidates.length,
      scope: result.verification,
      instructionsTruncated: result.instructionsTruncated,
    }),
    ...extra,
    testCode: result.testCode,
    imports: result.imports,
  };
}

export function formatWriteTest(report: WriteTestReport): string {
  const extra: string[] = [];
  if (report.file) extra.push(`  test file: ${report.file}`);
  if (report.testCode) extra.push(`  ${report.testCode.split("\n").join("\n  ")}`);
  return formatBase(
    report,
    `fcx test ${report.source ?? ""}${report.symbol ? `:${report.symbol}` : ""}`,
    extra,
  );
}

/** Parses `file:symbol` for the CLI. Returns the input or a usage message. */
export function parseWriteTestTarget(target: string | undefined): WriteTestInput | string {
  if (target === undefined) return "usage: fcx test <file:symbol>";
  const parsed = parseFileSymbolRequired(target);
  if (typeof parsed === "string") return parsed;
  return { file: parsed.file, symbol: parsed.symbol ?? "" };
}

export function runWriteTestCli(args: GlobalArgs, cwd: string): Promise<number> {
  const extra = tooManyArguments(args.rest, 1, "fcx test <file:symbol>");
  return runRecipeCli({
    args,
    cwd,
    command: "test",
    recipe: "write-test",
    parsed: toParsed(extra ?? parseWriteTestTarget(args.rest[0])),
    core: runWriteTestCommand,
    format: formatWriteTest,
  });
}
