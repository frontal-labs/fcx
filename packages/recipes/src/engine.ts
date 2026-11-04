import { existsSync, readFileSync } from "node:fs";
import { basename, relative, sep } from "node:path";
import { type Edit, resolveInWorkspace } from "@fcx/apply";
import { type Bundle, type LayerOutcome, anchor, constrain, verify } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import type { Checker, Diagnostic } from "@fcx/verify";
import * as z from "zod";
import { prepareInstructions, withInstructions } from "./instructions.js";

/**
 * The shared recipe loop (plan §9.2, §10). A recipe supplies a schema, a prompt, temperatures, `toEdits`, and an
 * ordered list of layers. The engine generates candidates one at a time, runs the layers in order, stops at the
 * first candidate that passes all of them, and feeds the first failure back into the next prompt.
 */

/** Temperatures for successive candidates (plan §10). Candidates run one at a time. */
/**
 * A model sometimes names a file by a path it made up ("/src/a.ts", "/path/to/a.ts"), and constrain then rejects a
 * correct edit. An edit whose path is outside the workspace, or does not exist, is pointed at the allowed file that
 * has the same name. With one allowed file, that file is used whatever the name. A real file the recipe may not
 * touch is left alone, so constrain still rejects it. Constrain and every later layer still run on the result.
 */
export function pinEditsToTarget(
  edits: readonly Edit[],
  workspace: string,
  allowedFiles: readonly string[],
): Edit[] {
  if (allowedFiles.length === 0) return [...edits];
  const relFor = (file: string) => relative(workspace, file).split(sep).join("/");
  return edits.map((edit) => {
    let resolved: string | undefined;
    try {
      resolved = resolveInWorkspace(workspace, edit.file);
    } catch {
      resolved = undefined;
    }
    if (resolved !== undefined && (allowedFiles.includes(resolved) || existsSync(resolved)))
      return edit;
    const name = basename(edit.file);
    const sameName = allowedFiles.filter((file) => basename(file) === name);
    const target =
      sameName.length === 1 ? sameName[0] : allowedFiles.length === 1 ? allowedFiles[0] : undefined;
    return target === undefined ? edit : { ...edit, file: relFor(target) };
  });
}

export const CANDIDATE_TEMPERATURES = [0.2, 0.5, 0.7, 0.9, 1.0, 1.0] as const;

/** An `edits` output with between one and `max` search/replace blocks. */
export function editsSchema(max: number) {
  return z.object({
    edits: z
      .array(
        z.object({
          file: z.string().min(1),
          search: z.string(),
          replace: z.string(),
        }),
      )
      .min(1)
      .max(max),
  });
}

export interface CandidateReport {
  /** Where the candidate came from: the compiler's quick fix (deterministic) or the model. */
  source: "compiler" | "model";
  /** Sampling temperature for model candidates; 0 for the compiler. */
  temperature: number;
  ms: number;
  pass: boolean;
  /** Set when the model produced output that did not match the schema. */
  error?: string;
  layers: LayerOutcome[];
  edits?: Edit[];
}

export interface LayerEvent {
  file: string;
  candidate: number;
  layer: string;
  pass: boolean;
  reasonCode?: string;
  ms: number;
}

/**
 * A candidate starting or ending, reported to every observer registered with `observeCandidates`. `ordinal` is
 * 1-based across the run's candidates (the compiler's quick fix first, when there is one). `of` is how many
 * candidates the run will try at most. The end event carries the verdict and the first failing layer.
 */
export interface CandidateEvent {
  readonly phase: "start" | "end";
  readonly ordinal: number;
  readonly of: number;
  readonly source: "compiler" | "model";
  /** Sampling temperature for model candidates; 0 for the compiler. */
  readonly temperature: number;
  /** Set on "end" only. */
  readonly pass?: boolean;
  /** Set on "end" when the candidate failed: the layer that stopped it. */
  readonly failedLayer?: string;
  readonly reasonCode?: string;
}

const candidateObservers = new Set<(event: CandidateEvent) => void>();

/**
 * Subscribes to candidate start and end events from every engine run in this process. Returns the unsubscribe
 * function. The ACP handler uses this to stream "candidate n of N" progress. Runs are not otherwise affected.
 */
export function observeCandidates(observer: (event: CandidateEvent) => void): () => void {
  candidateObservers.add(observer);
  return () => {
    candidateObservers.delete(observer);
  };
}

function publishCandidate(event: CandidateEvent): void {
  for (const observer of candidateObservers) observer(event);
}

/** The layer that stopped a candidate, for the candidate end event. */
function failureOf(
  layers: readonly LayerOutcome[],
): Pick<CandidateEvent, "failedLayer" | "reasonCode"> {
  const failed = layers.find((l): l is Extract<LayerOutcome, { pass: false }> => !l.pass);
  return failed ? { failedLayer: failed.layer, reasonCode: failed.reasonCode } : {};
}

export interface RecipePrompt {
  /** Byte-stable instructions. Sent first, so the prompt cache can reuse it. */
  system: string;
  /** Per-request content: allowed files, diagnostics, context, and feedback. */
  user: string;
}

/** What a layer check sees for one candidate. */
export interface LayerCheckInput<O> {
  /** The parsed model output, or undefined for the compiler candidate. */
  readonly output: O | undefined;
  readonly edits: readonly Edit[];
  /** Candidate text per absolute path. Filled in by the anchor layer; empty before it runs. */
  readonly texts: ReadonlyMap<string, string>;
  /** Text on disk before the candidate, or undefined when the file does not exist. */
  readonly original: (absPath: string) => string | undefined;
  readonly bundle: Bundle;
}

export type LayerCheck<O> = (input: LayerCheckInput<O>) => LayerOutcome;

/**
 * One layer in the recipe's pipeline. `constrain` and `anchor` have engine defaults; the others need a check.
 * An omitted `constrain.check` means "every edit targets an allowed file".
 */
export type RecipeLayer<O> =
  | { readonly name: "constrain"; readonly check?: LayerCheck<O> }
  | { readonly name: "anchor" }
  | { readonly name: "ground"; readonly check: LayerCheck<O> }
  | { readonly name: "verify"; readonly check: LayerCheck<O> }
  | { readonly name: "cite"; readonly check: LayerCheck<O> };

export interface RecipeDefinition<O> {
  readonly schema: z.ZodType<O>;
  /** Temperatures in candidate order. The engine uses the first `maxCandidates`. */
  readonly temperatures: readonly number[];
  readonly maxTokens?: number;
  /** Builds the prompt. `feedback` is the previous candidate's failure, when there is one. */
  prompt(feedback: string | undefined): RecipePrompt;
  /**
   * Tidies a parsed output before any check sees it. Schemas cannot hold transforms, because the model is
   * constrained by the schema converted to JSON Schema, so this is where a recipe normalizes its output.
   */
  normalize?(output: O): O;
  /** Turns a parsed output into search/replace edits. */
  toEdits(output: O): Edit[];
  /** Optional deterministic first candidate, tried before any model candidate. */
  compiler?(): Edit[] | undefined;
  readonly layers: readonly RecipeLayer<O>[];
}

export interface RecipeRunOptions<O> {
  readonly recipe: RecipeDefinition<O>;
  readonly model: Pick<ModelHost, "generateObject">;
  readonly workspace: string;
  /** Absolute paths the candidate may touch. Used by the default constrain layer. */
  readonly allowedFiles: readonly string[];
  /** Absolute path the run is about. Reported in layer events and in `no-diagnostics`. */
  readonly primaryFile: string;
  /** Number of model candidates to try (plan §10: 4 on tier S, 6 on tier M). */
  readonly maxCandidates: number;
  readonly readFile?: (path: string) => string;
  readonly onLayer?: (event: LayerEvent) => void;
  /** False when the caller found nothing to fix. The engine then returns `no-diagnostics` without calling the model. */
  readonly hasWork?: boolean;
  /**
   * The project instruction block (plan §12.2). The engine puts it in the user part of every candidate's prompt,
   * after the system text. Empty or undefined leaves the prompt unchanged. See src/instructions.ts for the budget.
   */
  readonly instructions?: string;
}

export interface VerifiedResult<O> {
  status: "verified";
  /** The parsed output. Undefined when the compiler's quick fix passed. */
  output: O | undefined;
  source: "compiler" | "model";
  edits: Edit[];
  /** Absolute path to the exact candidate text that passed every layer. */
  texts: ReadonlyMap<string, string>;
  candidates: CandidateReport[];
  ms: number;
  /** True when the instruction block was longer than its budget and was cut before it was sent. */
  instructionsTruncated: boolean;
}

export interface AbstainedResult {
  status: "abstained";
  lastError: string;
  /** The last candidate that parsed, shown as "not verified". It is never applied automatically. */
  bestCandidate?: Edit[];
  candidates: CandidateReport[];
  ms: number;
  /** True when the instruction block was longer than its budget and was cut before it was sent. */
  instructionsTruncated: boolean;
}

export interface NoDiagnosticsResult {
  status: "no-diagnostics";
  file: string;
}

export type EngineResult<O> = VerifiedResult<O> | AbstainedResult | NoDiagnosticsResult;

/** Matches `ModelLoadError` by code, so this module does not load ggml-node at runtime. */
export function isModelLoadFailure(
  error: unknown,
): error is Error & { code: string; hint?: string } {
  return error instanceof Error && (error as { code?: unknown }).code === "MODEL_LOAD_ERROR";
}

/** Runs the recipe loop. See the module comment for the contract. */
export async function runRecipeEngine<O>(options: RecipeRunOptions<O>): Promise<EngineResult<O>> {
  const t0 = performance.now();
  const { recipe } = options;
  if (options.hasWork === false) {
    return { status: "no-diagnostics", file: options.primaryFile };
  }
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const bundle: Bundle = { workspace: options.workspace, allowedFiles: options.allowedFiles };
  const instructions = prepareInstructions(options.instructions);
  const reports: CandidateReport[] = [];
  let feedback: string | undefined;
  let bestCandidate: Edit[] | undefined;

  const evaluate = (
    output: O | undefined,
    edits: Edit[],
    index: number,
  ): { passed: boolean; layers: LayerOutcome[]; texts: Map<string, string> } =>
    runLayers(recipe.layers, {
      output,
      edits,
      bundle,
      readFile,
      onOutcome: (outcome) => {
        options.onLayer?.({
          file: options.primaryFile,
          candidate: index,
          layer: outcome.layer,
          pass: outcome.pass,
          reasonCode: outcome.pass ? undefined : outcome.reasonCode,
          ms: outcome.ms,
        });
        if (!outcome.pass) feedback = outcome.feedback;
      },
    });

  const temperatures = recipe.temperatures.slice(0, Math.max(1, options.maxCandidates));
  const quick = recipe.compiler?.();
  const of = (quick ? 1 : 0) + temperatures.length;

  // Candidate 0: the recipe's deterministic fix, when it has one. It needs no model and is exact.
  if (quick) {
    const c0 = performance.now();
    bestCandidate = quick;
    publishCandidate({ phase: "start", ordinal: 1, of, source: "compiler", temperature: 0 });
    const { passed, layers, texts } = evaluate(undefined, quick, 0);
    reports.push({
      source: "compiler",
      temperature: 0,
      ms: elapsed(c0),
      pass: passed,
      layers,
      edits: quick,
    });
    publishCandidate({
      phase: "end",
      ordinal: 1,
      of,
      source: "compiler",
      temperature: 0,
      pass: passed,
      ...failureOf(layers),
    });
    if (passed) {
      return {
        status: "verified",
        output: undefined,
        source: "compiler",
        edits: quick,
        texts,
        candidates: reports,
        ms: elapsed(t0),
        instructionsTruncated: instructions.truncated,
      };
    }
  }

  for (const temperature of temperatures) {
    const index = reports.length;
    const c0 = performance.now();
    const prompt = recipe.prompt(feedback);
    publishCandidate({ phase: "start", ordinal: index + 1, of, source: "model", temperature });

    let output: O;
    let edits: Edit[];
    let parsed = false;
    try {
      const result = await options.model.generateObject<O>({
        schema: recipe.schema,
        prompt: `${prompt.system}\n\n${withInstructions(prompt.user, instructions.text)}`,
        temperature,
        maxTokens: recipe.maxTokens ?? 768,
      });
      output = recipe.schema.parse(result.object);
      parsed = true;
      if (recipe.normalize) output = recipe.normalize(output);
      edits = pinEditsToTarget(recipe.toEdits(output), options.workspace, options.allowedFiles);
    } catch (error) {
      // A model that cannot load is an environment problem, not a bad candidate. Let it reach the caller.
      if (isModelLoadFailure(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      feedback = parsed
        ? `Your output was valid, but its edits could not be built: ${message}. Correct those lines and output only the JSON object.`
        : `The previous output did not match the required JSON schema (${message}). Output only the JSON object.`;
      reports.push({
        source: "model",
        temperature,
        ms: elapsed(c0),
        pass: false,
        error: message,
        layers: [],
      });
      options.onLayer?.({
        file: options.primaryFile,
        candidate: index,
        layer: "model",
        pass: false,
        reasonCode: "MODEL_OUTPUT_INVALID",
        ms: 0,
      });
      publishCandidate({
        phase: "end",
        ordinal: index + 1,
        of,
        source: "model",
        temperature,
        pass: false,
        failedLayer: "model",
        reasonCode: "MODEL_OUTPUT_INVALID",
      });
      continue;
    }

    bestCandidate = edits;
    const { passed, layers, texts } = evaluate(output, edits, index);
    reports.push({
      source: "model",
      temperature,
      ms: elapsed(c0),
      pass: passed,
      layers,
      edits,
    });
    publishCandidate({
      phase: "end",
      ordinal: index + 1,
      of,
      source: "model",
      temperature,
      pass: passed,
      ...failureOf(layers),
    });
    if (passed) {
      return {
        status: "verified",
        output,
        source: "model",
        edits,
        texts,
        candidates: reports,
        ms: elapsed(t0),
        instructionsTruncated: instructions.truncated,
      };
    }
  }

  const lastFailure = [...(reports.at(-1)?.layers ?? [])]
    .reverse()
    .find((l): l is Extract<LayerOutcome, { pass: false }> => !l.pass);
  return {
    status: "abstained",
    lastError: lastFailure?.feedback ?? "no candidate passed every check",
    bestCandidate,
    candidates: reports,
    ms: elapsed(t0),
    instructionsTruncated: instructions.truncated,
  };
}

export interface LayerRunInput<O> {
  readonly output: O | undefined;
  readonly edits: readonly Edit[];
  readonly bundle: Bundle;
  readonly readFile: (path: string) => string;
  /** Called once per layer that runs, pass or fail, in order. */
  readonly onOutcome?: (outcome: LayerOutcome) => void;
}

/**
 * Runs a recipe's layers in order over one candidate, stopping at the first failure. This is the only place the
 * layer sequence is executed, so the engine's model candidates and `verifyEdits` cannot drift apart.
 */
export function runLayers<O>(
  layers: readonly RecipeLayer<O>[],
  run: LayerRunInput<O>,
): { passed: boolean; layers: LayerOutcome[]; texts: Map<string, string> } {
  const { edits, bundle, readFile } = run;
  const original = (path: string): string | undefined =>
    existsSync(path) ? readFile(path) : undefined;
  const outcomes: LayerOutcome[] = [];
  const texts = new Map<string, string>();
  const input: LayerCheckInput<O> = { output: run.output, edits, texts, original, bundle };
  for (const layer of layers) {
    let outcome: LayerOutcome;
    switch (layer.name) {
      case "constrain":
        outcome = layer.check ? layer.check(input) : constrain(edits, bundle);
        break;
      case "anchor": {
        const anchored = anchorEdits(edits, bundle, readFile, original);
        for (const [path, text] of anchored.texts) texts.set(path, text);
        outcome = anchored.outcome;
        break;
      }
      case "ground":
      case "verify":
      case "cite":
        outcome = layer.check({ ...input, texts });
        break;
    }
    outcomes.push(outcome);
    run.onOutcome?.(outcome);
    if (!outcome.pass) return { passed: false, layers: outcomes, texts };
  }
  return { passed: true, layers: outcomes, texts };
}

export interface VerifyEditsOptions {
  /** The candidate's search/replace edits, exactly as a model or hosted answer proposed them. */
  readonly edits: readonly Edit[];
  readonly workspace: string;
  /** Absolute paths the candidate may touch. */
  readonly allowedFiles: readonly string[];
  /** Absolute path of the file the diagnostic is about. */
  readonly primaryFile: string;
  /** The primary file's text on disk. The edits are anchored and verified against it. */
  readonly text: string;
  readonly checker: Checker;
  /** The diagnostic the candidate must fix. */
  readonly target: Diagnostic;
  /** Errors in the primary file before the candidate. Verify only fails on errors that are new. */
  readonly originalErrors: readonly Diagnostic[];
  readonly readFile?: (path: string) => string;
}

export type VerifyEditsResult =
  | { pass: true; layers: LayerOutcome[] }
  | { pass: false; feedback: string; layers: LayerOutcome[] };

/**
 * The fix-diagnostic pipeline (constrain, anchor, verify) for one candidate that came from outside the engine,
 * such as a hosted escalation. It runs the same `runLayers` loop and the same layer order as `runRecipeEngine`,
 * so the same candidate gets the same verdict on both paths. Ground and cite are not run: fix-diagnostic does not
 * use them.
 */
export function verifyEdits(options: VerifyEditsOptions): VerifyEditsResult {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const { checker, target, originalErrors, primaryFile, text, workspace } = options;
  const layers: readonly RecipeLayer<undefined>[] = [
    { name: "constrain" },
    { name: "anchor" },
    {
      name: "verify",
      check: ({ texts }) =>
        verify({
          checker,
          file: primaryFile,
          workspace,
          candidateText: texts.get(primaryFile) ?? text,
          target,
          originalErrors,
        }),
    },
  ];
  const run = runLayers(layers, {
    output: undefined,
    edits: options.edits,
    bundle: { workspace, allowedFiles: options.allowedFiles },
    readFile,
  });
  if (run.passed) return { pass: true, layers: run.layers };
  const failure = run.layers.find((l): l is Extract<LayerOutcome, { pass: false }> => !l.pass);
  return {
    pass: false,
    feedback: failure?.feedback ?? "the candidate failed verification",
    layers: run.layers,
  };
}

/**
 * The default anchor layer. A `search` of "" on a file that does not exist creates the file with `replace` as its
 * text. Every other edit goes through the defense anchor, which requires exactly one match.
 */
function anchorEdits(
  edits: readonly Edit[],
  bundle: Bundle,
  readFile: (path: string) => string,
  original: (path: string) => string | undefined,
): { outcome: LayerOutcome; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  const rest: Edit[] = [];
  for (const edit of edits) {
    const path = resolveInWorkspace(bundle.workspace, edit.file);
    if (edit.search === "" && original(path) === undefined) {
      texts.set(path, edit.replace);
    } else {
      rest.push(edit);
    }
  }
  if (rest.length === 0) {
    return { outcome: { layer: "anchor", pass: true, ms: 0 }, texts };
  }
  const anchored = anchor(rest, bundle, readFile);
  for (const [path, text] of anchored.texts) texts.set(path, text);
  return { outcome: anchored.outcome, texts };
}

export function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}

/** Narrows an engine result for a recipe that always has work to do. */
export function requireWork<O>(result: EngineResult<O>): VerifiedResult<O> | AbstainedResult {
  if (result.status === "no-diagnostics") {
    throw new Error("the engine reported no-diagnostics for a run that always has work");
  }
  return result;
}

/** What a recipe's verification did and did not run. Reported with every result, so no gap is hidden. */
export interface VerificationScope {
  readonly ran: readonly string[];
  readonly notRun: readonly string[];
}
