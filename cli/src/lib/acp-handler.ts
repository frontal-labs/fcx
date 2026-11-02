/**
 * The ACP task handler behind `fcx acp` (plan §11.2). It turns one prompt into one CLI run.
 *
 * Routing: the prompt text goes through `route()`, the same router `fcx ask` uses. A routed recipe runs through
 * the same dispatch table as the CLI (`run` in app.ts, reached via `runCaptured`), with the same console capture
 * a warm request uses. The handler builds the command's arguments itself from the router's target. Model output
 * never becomes a flag: a target that starts with "-" is refused, and arguments are passed as data, never parsed
 * as global flags. A route that needs inputs a sentence cannot give (for example fix-test's failure text) runs
 * nothing and reports the command to type.
 *
 * Permissions (plan §2 rule 1): the client gains no permission. Each run gets `permissionMode` undefined, so the
 * mode is the one `resolveConfig` gives the workspace from config alone. Hosted escalation is off (`noEscalate`).
 * Interactive prompts decline (protocol mode, and the warm-request guard). The handler never calls the client's
 * file-system or terminal methods (the agent advertises none). Edits go through the CLI's own apply path
 * (`applyPlan`), and only in the mode the config gives. Nothing here adds a permission a plain `fcx` run lacks.
 *
 * Cancellation: an aborted signal returns "cancelled" at once. A run still generating when the signal aborts
 * cannot write: every apply path checks `writesPermitted()` right before it writes.
 *
 * Progress: `route` (the routing decision), `candidate` (each candidate's start, with its number of N and its
 * temperature), `candidate-result` (its verdict, and the first failing layer), `check` (each defense layer, per
 * candidate), `run` (the command) and `result` (its exit code). Candidate events come from the recipe engine, so
 * a recipe that runs its own loop (explain) reports layer checks but no candidate events. Runs are serialized,
 * because the console capture and the active-turn guard are process-wide.
 *
 * Models: when `models` is given (the `fcx acp` process), each prompt is bracketed with `beginPrompt` and
 * `endPrompt`, so the idle unload never runs during a prompt. The cache itself is installed by `runtime.ts`.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type {
  AcpHandler,
  ProgressReporter,
  ProgressUpdate,
  TaskRequest,
  TaskResult,
} from "@fcx/acp";
import { RECIPE_DESCRIPTIONS, RECIPE_IDS, type RecipeId, route } from "@fcx/recipes";
// The candidate observer lives in the engine module. The recipes barrel does not re-export it.
import { type CandidateEvent, observeCandidates } from "@fcx/recipes";
import type { GlobalArgs } from "../args.js";
import { RECIPE_COMMANDS } from "../commands/ask.js";
import { setActiveTurn } from "./approval.js";
import type { ModelHostCache } from "./model-cache.js";
import { observeLayers, recipeEnvFor, startRun } from "./recipe-runtime.js";
import { runCaptured } from "./serve.js";

const CANCELLED: TaskResult = { stopReason: "cancelled", summary: "" };

/** How one routed recipe maps onto a command in the dispatch table. */
interface Dispatch {
  readonly command: string;
  /** Arguments after the command. Undefined when the sentence cannot supply what the command needs. */
  rest(target: string | undefined, text: string): string[] | undefined;
}

const withTarget =
  (build: (target: string, text: string) => string[]) =>
  (target: string | undefined, text: string): string[] | undefined =>
    target === undefined ? undefined : build(target, text);

const DISPATCH: Readonly<Record<RecipeId, Dispatch>> = {
  "fix-diagnostic": { command: "fix", rest: withTarget((target) => [target]) },
  "fix-test": { command: "fix-test", rest: () => undefined },
  "write-test": { command: "test", rest: withTarget((target) => [target]) },
  implement: { command: "implement", rest: withTarget((target) => [target]) },
  "add-types": { command: "types", rest: withTarget((target) => [target]) },
  docstring: { command: "doc", rest: withTarget((target) => [target]) },
  "refactor-small": { command: "refactor", rest: withTarget((target, text) => [target, text]) },
  "rename-extract": { command: "rename", rest: withTarget((target) => [target]) },
  explain: { command: "explain", rest: withTarget((target, text) => [target, text]) },
  "commit-message": { command: "commit", rest: () => [] },
};

export interface AcpHandlerOptions {
  /** The process's model host cache. Prompts are bracketed with it, so an idle unload waits for them. */
  readonly models?: ModelHostCache;
}

/**
 * Creates the handler for `createAcpAgent`. Each call has its own queue, so one server runs one command at a time.
 */
export function createAcpHandler(options: AcpHandlerOptions = {}): AcpHandler {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    runTask(task, progress, signal) {
      if (signal.aborted) return Promise.resolve(CANCELLED);
      if (!isAbsolute(task.cwd)) {
        return Promise.resolve(errorResult(`cwd must be an absolute path: ${task.cwd}`));
      }
      if (!isDirectory(task.cwd)) {
        return Promise.resolve(errorResult(`cwd is not an existing directory: ${task.cwd}`));
      }
      const work = queue.then(() => execute(task, progress, signal, options.models));
      queue = work.catch(() => undefined);
      return raceAbort(work, signal);
    },
  };
}

/** Resolves "cancelled" as soon as the signal aborts. The queued work keeps running, but it cannot write. */
function raceAbort(work: Promise<TaskResult>, signal: AbortSignal): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve(CANCELLED);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function execute(
  task: TaskRequest,
  progress: ProgressReporter,
  signal: AbortSignal,
  models: ModelHostCache | undefined,
): Promise<TaskResult> {
  if (signal.aborted) return CANCELLED;
  setActiveTurn(signal);
  models?.beginPrompt();
  try {
    return await routeAndRun(task, progress, signal);
  } catch (error) {
    return signal.aborted ? CANCELLED : errorResult(errorText(error));
  } finally {
    models?.endPrompt();
    setActiveTurn(undefined);
  }
}

async function routeAndRun(
  task: TaskRequest,
  progress: ProgressReporter,
  signal: AbortSignal,
): Promise<TaskResult> {
  const base = baseArgs(task.cwd, undefined, []);
  const env = await recipeEnvFor(base, task.cwd);
  const state = startRun(env, "acp", null);
  progress({ kind: "route", message: "routing task" });
  const routed = await route({
    model: env.model,
    text: task.text,
    instructions: state.instructions,
  });
  if (signal.aborted) return CANCELLED;

  if (routed.recipe === "unsupported") {
    progress({ kind: "route", message: `unsupported: ${routed.reason}` });
    return { stopReason: "end_turn", summary: capabilitiesSummary(routed.reason) };
  }

  const recipe: RecipeId = routed.recipe;
  const target = safeTarget(routed.target);
  progress({
    kind: "route",
    message: `routed to ${recipe}${target === undefined ? "" : ` (${target})`}`,
  });

  const dispatch = DISPATCH[recipe];
  const rest = dispatch.rest(target, task.text);
  if (rest === undefined) {
    return {
      stopReason: "end_turn",
      summary:
        `routed to ${recipe}. Nothing was run: this recipe needs inputs a sentence cannot give.\n` +
        `  run: ${RECIPE_COMMANDS[recipe]}`,
    };
  }

  const unobserve = observeLayers((event) => {
    if (signal.aborted) return;
    const verdict = event.pass ? "pass" : `fail${event.reasonCode ? ` (${event.reasonCode})` : ""}`;
    progress({ kind: "check", message: `${event.layer} candidate ${event.candidate}: ${verdict}` });
  });
  const unobserveCandidates = observeCandidates((event) => {
    if (signal.aborted) return;
    progress(candidateProgress(event));
  });
  progress({ kind: "run", message: `running fcx ${dispatch.command}` });
  const result = await runCaptured(baseArgs(task.cwd, dispatch.command, rest)).finally(() => {
    unobserve();
    unobserveCandidates();
  });
  if (signal.aborted) return CANCELLED;

  progress({ kind: "result", message: `exit ${result.exitCode}` });
  const summary = [result.stdout, result.stderr]
    .filter((part) => part.trim() !== "")
    .join("\n")
    .trim();
  return { stopReason: result.exitCode === 1 ? "error" : "end_turn", summary };
}

/** The progress update for one candidate's start or end. */
function candidateProgress(event: CandidateEvent): ProgressUpdate {
  const source = event.source === "compiler" ? "compiler quick fix" : "model";
  if (event.phase === "start") {
    return {
      kind: "candidate",
      message: `candidate ${event.ordinal} of ${event.of} (${source}, temperature ${event.temperature})`,
    };
  }
  const verdict = event.pass
    ? "pass"
    : `fail at ${event.failedLayer ?? "unknown layer"}${event.reasonCode ? ` (${event.reasonCode})` : ""}`;
  return {
    kind: "candidate-result",
    message: `candidate ${event.ordinal} of ${event.of}: ${verdict}`,
  };
}

/**
 * The arguments a run gets. `permissionMode` is undefined on purpose: the CLI resolves it from config. Nothing
 * from the client is copied in.
 */
function baseArgs(cwd: string, command: string | undefined, rest: string[]): GlobalArgs {
  return {
    command,
    rest,
    outputFormat: "text",
    permissionMode: undefined,
    cwd,
    dryRun: false,
    noEscalate: true,
    help: false,
    version: false,
  };
}

/** A router target that could be read as a flag, or that spans lines, is dropped. */
function safeTarget(target: string | undefined): string | undefined {
  if (target === undefined) return undefined;
  const trimmed = target.trim();
  if (trimmed === "" || trimmed.startsWith("-") || /[\r\n]/.test(trimmed)) return undefined;
  return trimmed;
}

function capabilitiesSummary(reason: string): string {
  const lines = [reason, "fcx can:"];
  for (const id of RECIPE_IDS) {
    lines.push(`  ${RECIPE_COMMANDS[id]}`, `    ${RECIPE_DESCRIPTIONS[id]}`);
  }
  return lines.join("\n");
}

function errorResult(summary: string): TaskResult {
  return { stopReason: "error", summary };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
