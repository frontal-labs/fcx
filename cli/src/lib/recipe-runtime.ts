import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Edit,
  EditError,
  StaleFileError,
  applyPlan,
  planEdits,
  resolveInWorkspace,
} from "@fcx/apply";
import type { PermissionMode } from "@fcx/config";

import type { ModelHost } from "@fcx/model";
import {
  type CandidateReport,
  type LayerEvent,
  RecipeInputError,
  type VerificationScope,
} from "@fcx/recipes";
import type { GlobalArgs, OutputFormat } from "../args.js";
import { emit } from "../output.js";
import { askToApply, writesPermitted } from "./approval.js";
import { resolveFcxConfig } from "./config.js";
import { instructionsFor } from "./instructions.js";
import { indexPathFor, undoRootFor } from "./repo.js";
import { candidateBudget, createModelHost } from "./runtime.js";

/** Result states shared by every recipe command. Each maps to one exit code (see exitCodeFor). */
export type CommandStatus =
  | "applied"
  | "proposed"
  | "answered"
  | "routed"
  | "abstained"
  | "declined"
  | "nothing-to-annotate"
  | "no-changes"
  | "unsupported"
  | "error";

/** Fields every recipe command reports, in JSON and text. */
export interface RecipeReportBase {
  /** The CLI command name, for example `fix-test`. */
  command: string;
  /** The recipe id that ran, or null when no recipe ran. */
  recipe: string | null;
  status: CommandStatus;
  file?: string;
  /** Edits that were applied, proposed, or (when abstained) the unverified best candidate. */
  edits?: Edit[];
  undoId?: string;
  candidates: number;
  /** How many candidates were attempted (covers compiler + model candidates). */
  candidatesTried?: number;
  /** The 1-based ordinal of the first candidate that passed, or undefined when none passed. */
  firstPassCandidate?: number;
  /** The reason the run abstained, when it did. */
  abstainedReason?: string;
  /** How many distinct files were packed into the context. */
  contextFiles?: number;
  /** Character count of the prompt sent to the model. */
  promptChars?: number;
  /** Estimated token count of the prompt sent to the model. */
  promptTokens?: number;
  lastError?: string;
  error?: { code: string; message: string };
  /** Checks the recipe did not run, from its verification scope. */
  notChecked: string[];
  /** The project instruction block that was sent, or "" when there was none. */
  instructions: string;
  warnings: string[];
  ms: number;
}

/** Everything a recipe command needs from the environment. Tests build this directly with a scripted model. */
export interface RecipeEnv {
  workspace: string;
  model: Pick<ModelHost, "generateObject" | "countTokens">;
  maxCandidates: number;
  indexPath: string;
  undoRoot: string;
  logsDir: string;
  permissionMode: PermissionMode;
  dryRun: boolean;
  approve: (proposal: { file: string; edits: Edit[] }) => Promise<boolean>;
}

/** Per-run state: the start time, the instruction block and the warnings collected so far. */
export interface RunState {
  env: RecipeEnv;
  command: string;
  recipe: string | null;
  t0: number;
  warnings: string[];
  instructions: string;
}

/** Exit codes shared by every recipe command (plan section 11.1). */
export function exitCodeFor(status: CommandStatus): number {
  switch (status) {
    case "applied":
    case "proposed":
    case "answered":
    case "routed":
    case "nothing-to-annotate":
      return 0;
    case "abstained":
      return 2;
    case "declined":
      return 3;
    case "no-changes":
    case "unsupported":
    case "error":
      return 1;
  }
}

/** Starts a run. Project instructions come from the target file's directory, or the root when there is no file. */
export function startRun(
  env: RecipeEnv,
  command: string,
  recipe: string | null,
  file?: string,
): RunState {
  const warnings: string[] = [];
  const target =
    file === undefined ? join(env.workspace, "AGENTS.md") : safeResolve(env.workspace, file);
  const instructions = target === undefined ? "" : instructionsFor(env.workspace, target, warnings);
  return { env, command, recipe, t0: performance.now(), warnings, instructions };
}

/** Builds the common report. `instructionsTruncated` adds a warning, since the instructions were cut to budget. */
export function completeRun(
  state: RunState,
  outcome: {
    status: CommandStatus;
    file?: string;
    edits?: Edit[];
    undoId?: string;
    candidates?: number;
    candidatesTried?: number;
    firstPassCandidate?: number;
    abstainedReason?: string;
    contextFiles?: number;
    promptChars?: number;
    promptTokens?: number;
    lastError?: string;
    scope?: VerificationScope;
    instructionsTruncated?: boolean;
  },
): RecipeReportBase {
  const warnings = [...state.warnings];
  if (outcome.instructionsTruncated)
    warnings.push("project instructions were cut to the 300-token budget");
  return {
    command: state.command,
    recipe: state.recipe,
    status: outcome.status,
    file: outcome.file,
    edits: outcome.edits,
    undoId: outcome.undoId,
    candidates: outcome.candidates ?? 0,
    candidatesTried: outcome.candidatesTried,
    firstPassCandidate: outcome.firstPassCandidate,
    abstainedReason: outcome.abstainedReason,
    contextFiles: outcome.contextFiles,
    promptChars: outcome.promptChars,
    promptTokens: outcome.promptTokens,
    lastError: outcome.lastError,
    notChecked: outcome.scope ? [...outcome.scope.notRun] : [],
    instructions: state.instructions,
    warnings,
    ms: Math.round(performance.now() - state.t0),
  };
}

/** Computes run-level metrics from a recipe's candidate reports. */
export function candidateMetrics(candidates: CandidateReport[]): {
  candidatesTried: number;
  firstPassCandidate: number | undefined;
  contextFiles: number | undefined;
  promptChars: number | undefined;
  promptTokens: number | undefined;
} {
  const candidatesTried = candidates.length;
  const firstPass = candidates.findIndex((c) => c.pass);
  const contextFiles =
    candidates.length > 0 ? Math.max(...candidates.map((c) => c.filesPacked ?? 0)) : undefined;
  const promptChars =
    candidates.length > 0 ? Math.max(...candidates.map((c) => c.contextBytes ?? 0)) : undefined;
  const promptTokens =
    candidates.length > 0 ? Math.max(...candidates.map((c) => c.promptTokens ?? 0)) : undefined;
  return {
    candidatesTried,
    firstPassCandidate: firstPass === -1 ? undefined : firstPass + 1,
    contextFiles: contextFiles === 0 ? undefined : contextFiles,
    promptChars: promptChars === 0 ? undefined : promptChars,
    promptTokens: promptTokens === 0 ? undefined : promptTokens,
  };
}

/** A failed run: input errors are reported as INVALID_INPUT, everything else as RECIPE_FAILED. */
export function failedRun(state: RunState, error: unknown, code?: string): RecipeReportBase {
  const base = completeRun(state, { status: "error" });
  return {
    ...base,
    error: {
      code: code ?? (error instanceof RecipeInputError ? "INVALID_INPUT" : "RECIPE_FAILED"),
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/** A usage problem, reported before any model is called. */
export function usageReport(
  command: string,
  recipe: string | null,
  message: string,
): RecipeReportBase {
  return {
    command,
    recipe,
    status: "error",
    candidates: 0,
    notChecked: [],
    instructions: "",
    warnings: [],
    ms: 0,
    error: { code: "USAGE", message },
  };
}

/** The resolved path, or undefined when it escapes the workspace. The recipe reports the real error. */
function safeResolve(workspace: string, file: string): string | undefined {
  try {
    return resolveInWorkspace(workspace, file);
  } catch {
    return undefined;
  }
}

/** Absolute path of a workspace file, throwing when the path escapes the workspace. */
export function absoluteTarget(workspace: string, file: string): string {
  return resolveInWorkspace(workspace, file);
}

export type ApplyOutcome =
  | { status: "applied"; undoId: string }
  | { status: "proposed" }
  | { status: "declined" }
  | { status: "error"; code: string; message: string };

/**
 * Applies verified edits under the same rules as `fix`: read-only and dry-run only propose, prompt mode asks first,
 * and the other modes write. `bases` holds the text each file's edits were verified against, keyed by path, so a
 * change made during generation is refused rather than overwritten.
 */
export async function applyRecipeEdits(
  env: RecipeEnv,
  edits: readonly Edit[],
  bases: ReadonlyMap<string, string>,
): Promise<ApplyOutcome> {
  if (edits.length === 0 || env.dryRun || env.permissionMode === "read-only") {
    return { status: "proposed" };
  }
  // A cancelled ACP prompt may still be generating. It must never reach a write.
  if (!writesPermitted()) return { status: "declined" };
  if (env.permissionMode === "prompt") {
    const files = [...new Set(edits.map((e) => e.file))].join(", ");
    const approved = await env.approve({ file: files, edits: [...edits] });
    if (!approved) return { status: "declined" };
  }
  try {
    const baseByPath = new Map<string, string>();
    for (const [file, text] of bases) baseByPath.set(resolveInWorkspace(env.workspace, file), text);
    const plan = planEdits(env.workspace, edits, baseByPath);
    const applied = applyPlan(plan, env.undoRoot);
    return { status: "applied", undoId: applied.undoId };
  } catch (error) {
    if (error instanceof StaleFileError) {
      return { status: "error", code: "STALE_FILE", message: error.message };
    }
    if (error instanceof EditError) {
      return { status: "error", code: "EDIT_FAILED", message: error.message };
    }
    throw error;
  }
}

/** What every verified or abstained recipe result carries into its report. */
export interface RecipeResultBody {
  file?: string;
  candidates: number;
  /** How many candidates were attempted. */
  candidatesTried?: number;
  /** The 1-based ordinal of the first candidate that passed. */
  firstPassCandidate?: number;
  /** The reason the run abstained, when it did. */
  abstainedReason?: string;
  /** How many distinct files were packed into the context. */
  contextFiles?: number;
  /** Character count of the prompt sent to the model. */
  promptChars?: number;
  /** Estimated token count of the prompt sent to the model. */
  promptTokens?: number;
  scope: VerificationScope;
  instructionsTruncated: boolean;
}

/**
 * Applies a verified result and reports the outcome. A write error is reported as an error, never thrown, so
 * the CLI always prints a report and exits with a code.
 */
export async function applyVerified(
  state: RunState,
  edits: readonly Edit[],
  bases: ReadonlyMap<string, string>,
  body: RecipeResultBody,
): Promise<RecipeReportBase> {
  let outcome: ApplyOutcome;
  try {
    outcome = await applyRecipeEdits(state.env, edits, bases);
  } catch (error) {
    return failedRun(state, error);
  }
  switch (outcome.status) {
    case "applied":
      return completeRun(state, {
        ...body,
        status: "applied",
        edits: [...edits],
        undoId: outcome.undoId,
      });
    case "proposed":
      return completeRun(state, { ...body, status: "proposed", edits: [...edits] });
    case "declined":
      return completeRun(state, { ...body, status: "declined", edits: [...edits] });
    case "error":
      return failedRun(state, new Error(outcome.message), outcome.code);
  }
}

/** An abstained result. The best candidate is shown as unverified and is never applied. */
export function abstainedRun(
  state: RunState,
  body: RecipeResultBody & { lastError: string; bestCandidate?: readonly Edit[] },
): RecipeReportBase {
  return completeRun(state, {
    ...body,
    status: "abstained",
    edits: body.bestCandidate ? [...body.bestCandidate] : undefined,
  });
}

const layerObservers = new Set<(event: LayerEvent) => void>();

/**
 * Subscribes to every defense layer event the recipe commands emit, in order. Returns the unsubscribe function.
 * The ACP handler uses this to stream each check as progress.
 */
export function observeLayers(observer: (event: LayerEvent) => void): () => void {
  layerObservers.add(observer);
  return () => {
    layerObservers.delete(observer);
  };
}

/** Sends one layer event to every observer. */
export function publishLayerEvent(event: LayerEvent): void {
  for (const observer of layerObservers) observer(event);
}

/** Appends each defense layer event to `<logsDir>/fc/defense.jsonl`, the same log `fix` writes. */
export function layerLogger(logsDir: string, command: string): (event: LayerEvent) => void {
  const logDir = join(logsDir, "fc");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "defense.jsonl");
  return (event) => {
    appendFileSync(logPath, `${JSON.stringify({ task: command, ...event })}\n`);
    publishLayerEvent(event);
  };
}

/** The index database lives in a cache directory that may not exist yet. */
export function prepareIndexPath(indexPath: string): string {
  mkdirSync(dirname(indexPath), { recursive: true });
  return indexPath;
}

/** Text lines for the parts of a report every recipe command shares. */
export function formatBase(
  report: RecipeReportBase,
  title: string,
  extra: readonly string[] = [],
): string {
  const lines = [`${title}: ${report.status}`, ...extra];
  if (report.error) lines.push(`  ${report.error.code}: ${report.error.message}`);
  if (report.status === "abstained") {
    lines.push(`  not verified; not applied. last check: ${report.lastError ?? "unknown"}`);
  }
  if (report.status === "applied" && report.undoId) {
    lines.push(`  applied. undo with: fcx undo (id ${report.undoId})`);
  }
  if (
    report.edits &&
    report.edits.length > 0 &&
    ["applied", "proposed", "abstained", "declined"].includes(report.status)
  ) {
    for (const edit of report.edits) {
      lines.push(
        `  --- ${edit.file}\n  - ${edit.search.split("\n").join("\n  - ")}\n  + ${edit.replace.split("\n").join("\n  + ")}`,
      );
    }
  }
  lines.push(`  candidates: ${report.candidates}, time ${report.ms} ms`);
  if (report.notChecked.length > 0) lines.push(`  not checked: ${report.notChecked.join("; ")}`);
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}

/** Builds the environment from the resolved config, the same way `fix` does. */
export async function recipeEnvFor(args: GlobalArgs, cwd: string): Promise<RecipeEnv> {
  const resolved = resolveFcxConfig(cwd, { permissionMode: args.permissionMode });
  return {
    workspace: cwd,
    model: await createModelHost(resolved.local),
    maxCandidates: candidateBudget(resolved.local),
    indexPath: indexPathFor(resolved.paths.cacheDir, cwd),
    undoRoot: undoRootFor(resolved.paths.cacheDir, cwd),
    logsDir: resolved.paths.logsDir,
    permissionMode: resolved.permissionMode,
    dryRun: args.dryRun,
    approve: (proposal) => askToApply(proposal),
  };
}

/** Prints a report in the requested format and returns the exit code for its status. */
export function emitReport(
  format: OutputFormat,
  report: RecipeReportBase,
  text: () => string,
): number {
  emit(format, report, text);
  return exitCodeFor(report.status);
}

/** A parsed input, or the usage message that explains why it could not be parsed. */
export type Parsed<I> = { ok: true; input: I } | { ok: false; message: string };

/** Wraps a parser result (a value, or a usage string) as a Parsed. */
export function toParsed<I>(value: I | string): Parsed<I> {
  return typeof value === "string" ? { ok: false, message: value } : { ok: true, input: value };
}

/**
 * The shared CLI path for a recipe command: usage errors are reported before any model is loaded, then the
 * environment is built from the resolved config and the core runs.
 */
export async function runRecipeCli<I, R extends RecipeReportBase>(options: {
  args: GlobalArgs;
  cwd: string;
  command: string;
  recipe: string | null;
  parsed: Parsed<I>;
  core: (env: RecipeEnv, input: I) => Promise<R>;
  format: (report: R) => string;
}): Promise<number> {
  const { args, parsed } = options;
  if (!parsed.ok) {
    const report = usageReport(options.command, options.recipe, parsed.message);
    return emitReport(args.outputFormat, report, () =>
      formatBase(report, `fcx ${options.command}`),
    );
  }
  const env = await recipeEnvFor(args, options.cwd);
  const report = await options.core(env, parsed.input);
  return emitReport(args.outputFormat, report, () => options.format(report));
}

/** Usage error for a command that takes no more than `max` positional arguments. */
export function tooManyArguments(
  argv: readonly string[],
  max: number,
  usage: string,
): string | undefined {
  return argv.length > max ? `too many arguments. usage: ${usage}` : undefined;
}
