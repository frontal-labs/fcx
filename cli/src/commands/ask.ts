import {
  RECIPE_DESCRIPTIONS,
  RECIPE_IDS,
  type RecipeId,
  type RouteResult,
  route,
} from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import {
  type RecipeEnv,
  type RecipeReportBase,
  completeRun,
  emitReport,
  failedRun,
  formatBase,
  recipeEnvFor,
  startRun,
  usageReport,
} from "../lib/recipe-runtime.js";
import { type CommitInput, type CommitReport, formatCommit, runCommitCommand } from "./commit.js";

/** The command a user runs for each recipe. `<...>` marks inputs that `ask` cannot infer from a sentence. */
export const RECIPE_COMMANDS: Readonly<Record<RecipeId, string>> = {
  "fix-diagnostic": "fcx fix <file[:line]>",
  "fix-test": 'fcx fix-test <file> --name "<test name>" [--output "<failure text>"]',
  "write-test": "fcx test <file:symbol>",
  implement: "fcx implement <file:line>",
  "add-types": "fcx types <file[:symbol]>",
  docstring: "fcx doc <file:line>",
  "refactor-small": 'fcx refactor <file:start-end> "<instruction>"',
  "rename-extract": "fcx rename <file:line:column> [new-name]",
  explain: 'fcx explain <file:start-end> ["<question>"]',
  "commit-message": "fcx commit",
};

export interface AskInput {
  /** The task as the user typed it. */
  text: string;
}

export interface AskReport extends RecipeReportBase {
  /** What the router decided. Absent when routing failed. */
  route?: { recipe: string; target?: string; reason?: string };
  /** The command to run when `ask` could not run the recipe itself. */
  suggestion?: string;
  /** Set on unsupported: what fcx can do instead. */
  capabilities?: Array<{ recipe: RecipeId; description: string; command: string }>;
  /** Set when the route ran commit-message: the generated message. */
  message?: string;
  commitSummary?: string;
}

/**
 * `fcx ask "<text>"`: routes the task to one recipe. A commit-message route runs with the repository as its input.
 * Other routes print the recipe and the command to run, because their inputs (a file, a line, a name) cannot be
 * inferred from a sentence. An unsupported task lists what fcx can do.
 */
export async function runAskCommand(env: RecipeEnv, input: AskInput): Promise<AskReport> {
  const state = startRun(env, "ask", null);
  let routed: RouteResult;
  try {
    routed = await route({ model: env.model, text: input.text, instructions: state.instructions });
  } catch (error) {
    return failedRun(state, error, "ROUTE_FAILED");
  }
  if (routed.instructionsTruncated) {
    state.warnings.push("project instructions were cut to the 300-token budget");
  }

  if (routed.recipe === "unsupported") {
    const base = completeRun(state, { status: "unsupported" });
    return {
      ...base,
      route: { recipe: "unsupported", reason: routed.reason },
      capabilities: RECIPE_IDS.map((recipe) => ({
        recipe,
        description: RECIPE_DESCRIPTIONS[recipe],
        command: RECIPE_COMMANDS[recipe],
      })),
    };
  }

  const routeInfo = { recipe: routed.recipe, target: routed.target };
  if (routed.recipe === "commit-message") {
    // The commit route needs nothing from the user, so it runs. --apply is never set here: ask never commits.
    const commitInput: CommitInput = { apply: false, confirm: async () => false };
    const report: CommitReport = await runCommitCommand(env, commitInput);
    return { ...report, command: "ask", route: routeInfo };
  }

  return {
    ...completeRun(state, { status: "routed" }),
    route: routeInfo,
    suggestion: RECIPE_COMMANDS[routed.recipe],
  };
}

export function formatAsk(report: AskReport): string {
  if (report.recipe === "commit-message" && report.route) {
    return formatCommit(report);
  }
  if (report.status === "unsupported") {
    const lines = [
      "fcx ask: unsupported",
      `  ${report.route?.reason ?? "fcx has no recipe for this task."}`,
      "  fcx can:",
    ];
    for (const c of report.capabilities ?? [])
      lines.push(`    ${c.command}`, `      ${c.description}`);
    return lines.join("\n");
  }
  const lines = [`fcx ask: routed to ${report.route?.recipe ?? "unknown"}`];
  if (report.route?.target) lines.push(`  router suggested target: ${report.route.target}`);
  lines.push(`  run: ${report.suggestion ?? ""}`);
  lines.push("  nothing was run: this recipe needs inputs ask cannot infer from a sentence");
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

export async function runAskCli(args: GlobalArgs, cwd: string): Promise<number> {
  const text = args.rest.join(" ").trim();
  if (text === "") {
    const report = usageReport("ask", null, 'usage: fcx ask "<text>"');
    return emitReport(args.outputFormat, report, () => formatBase(report, "fcx ask"));
  }
  const env = await recipeEnvFor(args, cwd);
  const report = await runAskCommand(env, { text });
  return emitReport(args.outputFormat, report, () => formatAsk(report));
}
