import { readFileSync } from "node:fs";
import { type FixTestResult, runFixTest } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import { parseCommandArgs } from "../lib/command-args.js";
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

export interface FixTestInput {
  /** The test file, workspace-relative or absolute. */
  file: string;
  /** The name passed to it() or test(). */
  testName: string;
  /** Failure output from the caller. fcx runs no tests, so this is the only failure text the model sees. */
  failureOutput?: string;
}

export interface FixTestReport extends RecipeReportBase {
  testName?: string;
  failureOutputGiven?: boolean;
}

/** `fcx fix-test`: changes the test or the code under test so the named test passes. Edits follow the apply rules. */
export async function runFixTestCommand(
  env: RecipeEnv,
  input: FixTestInput,
): Promise<FixTestReport> {
  const state = startRun(env, "fix-test", "fix-test", input.file);
  const extra = { testName: input.testName, failureOutputGiven: input.failureOutput !== undefined };
  try {
    const base = readFileSync(absoluteTarget(env.workspace, input.file), "utf8");
    const result: FixTestResult = await runFixTest({
      model: env.model,
      workspace: env.workspace,
      testFile: input.file,
      testName: input.testName,
      failureOutput: input.failureOutput,
      indexPath: prepareIndexPath(env.indexPath),
      maxCandidates: env.maxCandidates,
      onLayer: layerLogger(env.logsDir, "fix-test"),
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
      };
    }
    return {
      ...(await applyVerified(state, result.edits, new Map([[input.file, base]]), {
        file: input.file,
        candidates: result.candidates.length,
        scope: result.verification,
        instructionsTruncated: result.instructionsTruncated,
      })),
      ...extra,
    };
  } catch (error) {
    return { ...failedRun(state, error), ...extra };
  }
}

export function formatFixTest(report: FixTestReport): string {
  const extra = [`  test: ${report.testName ?? ""}`];
  extra.push(
    report.failureOutputGiven
      ? "  failure output: from --output (fcx runs no tests)"
      : "  failure output: none given; use --output to pass the test failure",
  );
  return formatBase(report, `fcx fix-test ${report.file ?? ""}`, extra);
}

export function runFixTestCli(args: GlobalArgs, cwd: string): Promise<number> {
  const parsed = parseCommandArgs(args.rest, { values: ["--name", "--output"], flags: [] });
  const input = typeof parsed === "string" ? parsed : fixTestInputFrom(parsed);
  return runRecipeCli({
    args,
    cwd,
    command: "fix-test",
    recipe: "fix-test",
    parsed: toParsed(input),
    core: runFixTestCommand,
    format: formatFixTest,
  });
}

function fixTestInputFrom(parsed: {
  positionals: string[];
  values: Map<string, string>;
}): FixTestInput | string {
  const [file, ...extra] = parsed.positionals;
  if (file === undefined || extra.length > 0) {
    return "usage: fcx fix-test <file> --name <test name> [--output <failure text>]";
  }
  const testName = parsed.values.get("--name");
  if (testName === undefined || testName.trim() === "") {
    return "fcx fix-test needs --name <test name>";
  }
  const failureOutput = parsed.values.get("--output");
  return { file, testName, failureOutput };
}
