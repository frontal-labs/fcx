import { readFileSync } from "node:fs";
import type { Edit } from "@fcx/apply";
import { verify } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { gatherFixContext, renderContext } from "@fcx/retrieve";
import { type Checker, type Diagnostic, compilerFix, errorsOnly } from "@fcx/verify";
import { type ContextReport, type DefinitionsAt, addLspDefinitions } from "./context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  editsSchema,
  elapsed,
  isModelLoadFailure,
  runRecipeEngine,
} from "./engine.js";
import { FIX_DIAGNOSTIC_SYSTEM } from "./prompts.js";

export { CANDIDATE_TEMPERATURES, isModelLoadFailure };
export type { CandidateReport, LayerEvent };

/** Output the model must produce. The runtime constrains decoding to this schema. */
export const FixOutputSchema = editsSchema(4);

export type FixOutput = { edits: Edit[] };

export type FixResult =
  | { status: "no-diagnostics"; file: string }
  | {
      status: "verified";
      diagnostic: Diagnostic;
      edits: Edit[];
      /** Absolute path of the file the edits apply to. */
      file: string;
      /** The exact text the edits were verified against. Applying must use this, not a fresh read. */
      baseText: string;
      candidates: CandidateReport[];
      ms: number;
      /** True when the instruction block was cut to its budget before it was sent. */
      instructionsTruncated: boolean;
      /** Where the definition context came from, and what was skipped. */
      context: ContextReport;
    }
  | {
      status: "abstained";
      diagnostic: Diagnostic;
      lastError: string;
      /** The last candidate, shown as "not verified". It is never applied automatically. */
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      /** True when the instruction block was cut to its budget before it was sent. */
      instructionsTruncated: boolean;
      /** Where the definition context came from, and what was skipped. */
      context: ContextReport;
    };

export interface FixOptions {
  model: Pick<ModelHost, "generateObject"> & { countTokens?: (text: string) => number };
  checker: Checker;
  workspace: string;
  /** Absolute path of the file to fix. */
  file: string;
  /** 1-based line. When omitted, the first error in the file is fixed. */
  line?: number;
  /** Number of candidates to try (plan §10: 4 on tier S, 6 on tier M). */
  maxCandidates: number;
  /** Character budget for retrieved context. */
  budgetChars?: number;
  readFile?: (path: string) => string;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
  /**
   * Definitions from a language server, added to the checker's context. Undefined means the checker alone. The
   * server gathers context only; verification is always the checker's.
   */
  definitionsAt?: DefinitionsAt;
}

/**
 * Runs the fix-diagnostic recipe on the shared engine. It retrieves context, generates candidates, and accepts the
 * first one that passes constrain, anchor and verify. A failure becomes feedback in the next prompt.
 */
export async function runFixDiagnostic(options: FixOptions): Promise<FixResult> {
  const t0 = performance.now();
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const text = readFile(options.file);
  const errors = errorsOnly(options.checker.diagnostics(options.file));
  const matching = errors.filter((d) => options.line === undefined || d.line === options.line);
  const target = matching[0];
  if (!target) {
    return { status: "no-diagnostics", file: options.file };
  }

  const retrieved = gatherFixContext({
    checker: options.checker,
    workspace: options.workspace,
    file: options.file,
    line: target.line,
    column: target.column,
    budgetChars: options.budgetChars,
  });
  const gathered = await addLspDefinitions({
    checker: options.checker,
    workspace: options.workspace,
    file: options.file,
    line: target.line,
    column: target.column,
    budgetChars: options.budgetChars,
    context: retrieved,
    definitionsAt: options.definitionsAt,
  });
  const contextText = renderContext(gathered.context);
  const rel = options.file.startsWith(`${options.workspace}/`)
    ? options.file.slice(options.workspace.length + 1)
    : options.file;

  const recipe: RecipeDefinition<FixOutput> = {
    schema: FixOutputSchema,
    temperatures: CANDIDATE_TEMPERATURES,
    prompt: (feedback) => ({
      system: FIX_DIAGNOSTIC_SYSTEM,
      user: buildUser({ text, rel, target, errorCount: errors.length, contextText, feedback }),
    }),
    toEdits: (output) => output.edits,
    compiler: () => {
      // The compiler's own quick fix, when it has one. It needs no model and is exact.
      const quick = compilerFix(options.checker, options.file, text, target);
      return quick ? [{ file: options.file, ...quick }] : undefined;
    },
    layers: [
      { name: "constrain" },
      { name: "anchor" },
      {
        name: "verify",
        check: ({ texts }) =>
          verify({
            checker: options.checker,
            file: options.file,
            workspace: options.workspace,
            candidateText: texts.get(options.file) ?? text,
            target,
            originalErrors: errors,
          }),
      },
    ],
  };

  const result = await runRecipeEngine({
    recipe,
    model: options.model,
    workspace: options.workspace,
    allowedFiles: [options.file],
    primaryFile: options.file,
    maxCandidates: options.maxCandidates,
    readFile,
    countTokens: options.model.countTokens,
    onLayer: options.onLayer,
    instructions: options.instructions,
  });

  if (result.status === "verified") {
    return {
      status: "verified",
      diagnostic: target,
      edits: result.edits,
      file: options.file,
      baseText: text,
      candidates: result.candidates,
      ms: elapsed(t0),
      instructionsTruncated: result.instructionsTruncated,
      context: gathered.report,
    };
  }
  if (result.status === "abstained") {
    return {
      status: "abstained",
      diagnostic: target,
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms: elapsed(t0),
      instructionsTruncated: result.instructionsTruncated,
      context: gathered.report,
    };
  }
  return { status: "no-diagnostics", file: options.file };
}

function buildUser(input: {
  text: string;
  rel: string;
  target: Diagnostic;
  errorCount: number;
  contextText: string;
  feedback?: string;
}): string {
  const others = input.errorCount - 1;
  const parts = [
    `Allowed files: ${input.rel}`,
    `Diagnostic: ${input.rel}:${input.target.line}:${input.target.column} TS${input.target.code} ${input.target.message}`,
  ];
  if (others > 0) {
    parts.push(`(${others} other error(s) in this file are not part of this request.)`);
  }
  parts.push(
    "",
    "Relevant code:",
    input.contextText,
    "",
    `File ${input.rel} around the error:`,
    numberLines(input.text, input.target.line, 40),
  );
  if (input.feedback) {
    parts.push("", `Your previous attempt was rejected: ${input.feedback}`);
  }
  return parts.join("\n");
}

function numberLines(text: string, line: number, radius: number): string {
  const lines = text.split("\n");
  const from = Math.max(0, line - 1 - radius);
  const to = Math.min(lines.length, line + radius);
  return lines
    .slice(from, to)
    .map((l, i) => `${String(from + i + 1).padStart(4)}| ${l}`)
    .join("\n");
}
