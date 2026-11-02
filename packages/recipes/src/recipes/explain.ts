/**
 * explain: explains a selected range of code, or answers a question about it, with cited claims.
 *
 * Input: a file, a 1-based inclusive line range, and an optional question.
 * Context: the selection with line numbers, plus the enclosing scope and the definitions the selection uses
 * (gatherFixContext from @fcx/retrieve), each with line numbers.
 * Output: { summary, claims: [{ text, cites: [{ file, start, end }] }] } with 1 to 12 claims.
 * Layers: cite (@fcx/defense). A claim survives only when every citation resolves to a real range in the workspace
 * and every code-like identifier in the claim appears in the cited lines. Failed claims are dropped, never repaired.
 * When more than half the claims are dropped, the model is asked once more. The best attempt is the answer. An
 * answer with no surviving claim is an abstention.
 *
 * Verifies: each kept claim cites real ranges, and its code-like identifiers appear in them.
 * Does NOT verify: that the summary is correct (it is not checked against the code), that the claims are true beyond
 * their cited identifiers, or anything by running code. This recipe is verified only by citation, not by execution.
 *
 * This recipe runs its own loop rather than the edit-based engine, because its output is an answer, not edits.
 */
import { resolve } from "node:path";
import { type CiteReasonCode, type Claim, cite } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { type ContextBlock, gatherFixContext } from "@fcx/retrieve";
import { createTsChecker } from "@fcx/verify";
import * as z from "zod";
import { RecipeInputError, absoluteIn, readText, relativeTo } from "../context.js";
import { type LayerEvent, type VerificationScope, isModelLoadFailure } from "../engine.js";
import { prepareInstructions, withInstructions } from "../instructions.js";

/** Temperatures for the first attempt and the one regeneration. */
export const EXPLAIN_TEMPERATURES = [0.2, 0.5] as const;

/** Claims per answer. The schema enforces the same bounds. */
export const EXPLAIN_MAX_CLAIMS = 12;

export const ExplainSchema = z.object({
  summary: z.string().min(1),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        // An empty list is allowed on purpose: cite then drops the claim with NO_CITATION, which is reported.
        cites: z.array(
          z.object({
            file: z.string().min(1),
            start: z.number().int(),
            end: z.number().int(),
          }),
        ),
      }),
    )
    .min(1)
    .max(EXPLAIN_MAX_CLAIMS),
});
export type ExplainOutput = z.infer<typeof ExplainSchema>;

export const EXPLAIN_SCOPE: VerificationScope = {
  ran: ["citation-ranges", "citation-identifiers"],
  notRun: [
    "execution: no code is run or tested",
    "summary text: not checked against the code",
    "claim truth beyond the cited identifiers",
  ],
};

/** A claim the cite layer dropped, and why. */
export interface DroppedClaim {
  claim: Claim;
  reasonCode: CiteReasonCode;
}

export interface ExplainAnswer {
  summary: string;
  claims: Claim[];
}

export interface ExplainOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The file that holds the selection, workspace-relative or absolute. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** The user's question. When omitted, the selection is explained. */
  question?: string;
  /** Character budget for the retrieved definitions. */
  budgetChars?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type ExplainResult =
  | {
      status: "answered";
      answer: ExplainAnswer;
      dropped: DroppedClaim[];
      attempts: number;
      /** True when the instruction block was cut to its budget before it was sent. */
      instructionsTruncated: boolean;
      verification: VerificationScope;
      ms: number;
    }
  | {
      status: "abstained";
      answer: ExplainAnswer;
      dropped: DroppedClaim[];
      lastError: string;
      attempts: number;
      /** True when the instruction block was cut to its budget before it was sent. */
      instructionsTruncated: boolean;
      verification: VerificationScope;
      ms: number;
    };

export const EXPLAIN_SYSTEM = `You are a coding agent explaining code. Given a selected range of code, the definitions it uses, and an optional question, write a short summary and a list of claims. Each claim is one statement about the code, with citations.

Constraints:
- Output must be valid JSON matching the schema: { "summary": "...", "claims": [{ "text": "...", "cites": [{ "file": "...", "start": 1, "end": 2 }] }] }.
- Each claim must cite at least one line range (file, start, end; 1-based, inclusive) that is shown to you. Cite the lines that contain the code the claim describes.
- Put every code identifier in backticks in the claim text, for example \`parseDate\` or \`cache.get\`. Each backticked identifier must appear in the text of the lines cited for that claim.
- Use at most 12 claims. Make each claim one short statement that the cited lines support.
- Do not make claims about behavior that the cited lines do not show.
- Do not invent file paths, line numbers, symbols, or package names.
- If a question is given, answer it. Otherwise explain what the selected code does.`;

/** Runs the explain recipe. Throws RecipeInputError when the file or the line range is invalid. */
export async function runExplain(options: ExplainOptions): Promise<ExplainResult> {
  const t0 = performance.now();
  const instructions = prepareInstructions(options.instructions);
  const workspace = resolve(options.workspace);
  const abs = absoluteIn(workspace, options.file);
  const text = readText(abs);
  const rel = relativeTo(workspace, abs);
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const { startLine, endLine } = options;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > lines.length
  ) {
    throw new RecipeInputError(
      `invalid line range ${startLine}-${endLine} in ${rel} (the file has ${lines.length} lines)`,
    );
  }

  const selection = lines.slice(startLine - 1, endLine);
  const firstText = selection.find((l) => l.trim() !== "") ?? "";
  const column = firstText.length - firstText.trimStart().length + 1;

  const checker = createTsChecker(workspace, abs);
  try {
    const context = gatherFixContext({
      checker,
      workspace,
      file: abs,
      line: startLine,
      column,
      budgetChars: options.budgetChars,
    });
    const blocks: ContextBlock[] = [context.enclosing, ...context.definitions].filter(
      (b): b is ContextBlock => b !== null,
    );
    const allowed = [rel, ...new Set(blocks.map((b) => b.file).filter((f) => f !== rel))];
    const selectionText = numberLines(selection, startLine);
    const contextText =
      blocks.length === 0
        ? "(none)"
        : blocks
            .map(
              (b) =>
                `--- ${b.file}:${b.startLine}-${b.endLine} (${b.why})\n${numberLines(b.text.split("\n"), b.startLine)}`,
            )
            .join("\n\n");
    const question = options.question?.trim() || "Explain what the selected code does.";

    let feedback: string | undefined;
    let best: { kept: number; answer: ExplainAnswer; dropped: DroppedClaim[] } | undefined;
    let lastError = "no claim cites a range that supports it";
    let attempts = 0;

    for (const temperature of EXPLAIN_TEMPERATURES) {
      const index = attempts;
      attempts++;
      const user = withInstructions(
        [
          `Allowed citation files: ${allowed.join(", ")}`,
          `Question: ${question}`,
          "",
          `Selection ${rel}:${startLine}-${endLine}:`,
          selectionText,
          "",
          "Definitions and enclosing scope the selection uses:",
          contextText,
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
        instructions.text,
      );

      const c0 = performance.now();
      let output: ExplainOutput;
      try {
        const result = await options.model.generateObject<unknown>({
          schema: ExplainSchema,
          prompt: `${EXPLAIN_SYSTEM}\n\n${user}`,
          temperature,
          maxTokens: 1024,
        });
        output = ExplainSchema.parse(result.object);
      } catch (error) {
        // A model that cannot load is an environment problem, not a bad answer. Let it reach the caller.
        if (isModelLoadFailure(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        lastError = `the output did not match the required JSON schema (${message})`;
        feedback = `The previous output did not match the required JSON schema (${message}). Output only the JSON object.`;
        options.onLayer?.({
          file: abs,
          candidate: index,
          layer: "model",
          pass: false,
          reasonCode: "MODEL_OUTPUT_INVALID",
          ms: Math.round(performance.now() - c0),
        });
        continue;
      }

      const verdict = cite(
        output.claims.map((c) => ({ text: c.text, cites: c.cites })),
        { workspace },
      );
      options.onLayer?.({
        file: abs,
        candidate: index,
        layer: "cite",
        pass: verdict.dropped.length === 0,
        reasonCode: verdict.dropped[0]?.reasonCode,
        ms: Math.round(performance.now() - c0),
      });

      // Ties go to the later attempt, so an abstention reports the last attempt's drops.
      const kept = verdict.kept.length;
      if (best === undefined || kept >= best.kept) {
        best = {
          kept,
          answer: { summary: output.summary, claims: verdict.kept },
          dropped: verdict.dropped,
        };
      }
      if (!verdict.regenerate) break;

      const reasons = verdict.dropped.map((d) => d.reasonCode).join(", ");
      feedback = `${verdict.dropped.length} of ${output.claims.length} claims were dropped (${reasons}). Cite only line ranges shown to you, and make sure every code identifier in a claim appears in the lines that claim cites.`;
    }

    const elapsed = Math.round(performance.now() - t0);
    if (best === undefined || best.kept === 0) {
      return {
        status: "abstained",
        answer: { summary: "", claims: [] },
        dropped: best?.dropped ?? [],
        lastError,
        attempts,
        instructionsTruncated: instructions.truncated,
        verification: EXPLAIN_SCOPE,
        ms: elapsed,
      };
    }
    return {
      status: "answered",
      answer: best.answer,
      dropped: best.dropped,
      attempts,
      instructionsTruncated: instructions.truncated,
      verification: EXPLAIN_SCOPE,
      ms: elapsed,
    };
  } finally {
    checker.dispose();
  }
}

/** Numbers `lines`, the first of which is 1-based line `first`. */
function numberLines(lines: readonly string[], first: number): string {
  return lines.map((l, i) => `${String(first + i).padStart(4)}| ${l}`).join("\n");
}
