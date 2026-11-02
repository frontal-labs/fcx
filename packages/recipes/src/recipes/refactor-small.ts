/**
 * refactor-small: carries out a small instruction over a selected range of code and its direct callers.
 *
 * Input: a file, a 1-based inclusive line range, and an instruction.
 * Context: the selection with line numbers; the callers of the symbols the selection declares, found with the
 * TypeScript language service (findReferences), shown as snippets around each reference; and the blocks retrieval
 * ranks around the selection.
 * Output: { edits: Edit[] }. Edits may touch only the selection's file and the files that reference its declarations.
 * Layers: constrain, anchor, ground (TypeScript identifiers), verify (type check).
 *
 * Verifies: edits apply exactly once; edits stay inside the allow-list; identifiers in changed lines resolve; no
 * candidate file gains a type error that it did not have before.
 * Does NOT verify: that the instruction was carried out faithfully, that behavior is preserved (no tests run), that
 * selections not declaring symbols reach their other callers, or that callers outside the workspace are updated.
 * Callers come from the language service, not from @fcx/index, because @fcx/index is not a dependency of this package.
 * Only references to symbols declared inside the selection are counted as callers.
 */
import { readFileSync } from "node:fs";
import { type Edit, isInside } from "@fcx/apply";
import type { ModelHost } from "@fcx/model";
import { retrieve } from "@fcx/retrieve";
import { type Checker, createTsChecker } from "@fcx/verify";
import ts from "typescript";
import { groundLayer, typeCheckLayer } from "../checks.js";
import {
  RecipeInputError,
  absoluteIn,
  lineOffset,
  linesOf,
  numberedRange,
  readText,
  relativeTo,
  renderBlocks,
} from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  editsSchema,
  requireWork,
  runRecipeEngine,
} from "../engine.js";
import { REFACTOR_SMALL_SYSTEM } from "../prompts.js";

export const RefactorSmallSchema = editsSchema(4);
export type RefactorSmallOutput = { edits: Edit[] };

export const REFACTOR_SMALL_SCOPE: VerificationScope = {
  ran: ["edit-apply", "ts-ground", "ts-type-check"],
  notRun: ["behavior (no tests run)", "callers outside the workspace"],
};

/** Reference snippets shown per caller file, and the number of identifiers examined in the selection. */
const SNIPPETS_PER_FILE = 6;
const SNIPPET_RADIUS = 3;
const MAX_IDENTIFIERS = 60;

export interface RefactorSmallOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The file that holds the selection, workspace-relative or absolute. */
  file: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  instruction: string;
  /** Index database used by retrieval. Created when missing. */
  indexPath: string;
  maxCandidates: number;
  contextBudgetTokens?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type RefactorSmallResult =
  | {
      status: "verified";
      edits: Edit[];
      /** Workspace-relative files the edits may touch: the selection's file and its callers. */
      allowedFiles: string[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      lastError: string;
      bestCandidate?: Edit[];
      allowedFiles: string[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** Runs the refactor-small recipe. Throws RecipeInputError for a bad range or an unknown file. */
export async function runRefactorSmall(
  options: RefactorSmallOptions,
): Promise<RefactorSmallResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const text = readText(abs);
  const rel = relativeTo(workspace, abs);
  const lineCount = text.split("\n").length;
  if (
    !Number.isInteger(options.startLine) ||
    !Number.isInteger(options.endLine) ||
    options.startLine < 1 ||
    options.endLine < options.startLine ||
    options.endLine > lineCount
  ) {
    throw new RecipeInputError(
      `invalid line range ${options.startLine}-${options.endLine} in ${rel}`,
    );
  }
  const selection = linesOf(text, options.startLine, options.endLine);
  const selectionStart = lineOffset(text, options.startLine);
  const selectionEnd = selectionStart + selection.length;

  // Retrieval refreshes the index and provides the surrounding context.
  const bundle = await retrieve(
    { workspace, file: abs, line: options.startLine, selection, text: options.instruction },
    { dbPath: options.indexPath, contextBudgetTokens: options.contextBudgetTokens },
  );

  const checker = createTsChecker(workspace, abs);
  try {
    const callers = findCallers(checker, abs, text, selectionStart, selectionEnd, workspace);
    const allowedFiles = [...new Set([abs, ...callers.keys()])];
    const allowedRel = allowedFiles.map((f) => relativeTo(workspace, f));

    const callerText = [...callers.entries()]
      .map(([file, snippets]) => `// ${relativeTo(workspace, file)}\n${snippets.join("\n...\n")}`)
      .join("\n\n");

    const recipe: RecipeDefinition<RefactorSmallOutput> = {
      schema: RefactorSmallSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: REFACTOR_SMALL_SYSTEM,
        user: [
          `Allowed files: ${allowedRel.join(", ")}`,
          `Instruction: ${options.instruction}`,
          "",
          `Selection (${rel}:${options.startLine}-${options.endLine}):`,
          numberedRange(text, options.startLine, options.endLine),
          "",
          "Callers of the symbols declared in the selection:",
          callerText || "(none found)",
          "",
          "Related code:",
          renderBlocks(bundle.blocks.filter((b) => b.why !== "target symbol")),
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: (output) => output.edits,
      layers: [
        { name: "constrain" },
        { name: "anchor" },
        { name: "ground", check: ({ texts, original }) => groundLayer(checker, texts, original) },
        {
          name: "verify",
          check: ({ texts, original }) => typeCheckLayer({ checker, workspace, texts, original }),
        },
      ],
    };

    const result = requireWork(
      await runRecipeEngine({
        recipe,
        model: options.model,
        workspace,
        allowedFiles,
        primaryFile: abs,
        maxCandidates: options.maxCandidates,
        onLayer: options.onLayer,
        instructions: options.instructions,
      }),
    );
    const ms = Math.round(performance.now() - t0);
    if (result.status === "verified") {
      return {
        status: "verified",
        edits: result.edits,
        allowedFiles: allowedRel,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: REFACTOR_SMALL_SCOPE,
      };
    }
    return {
      status: "abstained",
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      allowedFiles: allowedRel,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: REFACTOR_SMALL_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/**
 * Files outside the selection that reference a symbol declared inside it, with snippets around each reference.
 * Only files inside the workspace, and never declaration sites, are returned.
 */
function findCallers(
  checker: Checker,
  abs: string,
  text: string,
  selectionStart: number,
  selectionEnd: number,
  workspace: string,
): Map<string, string[]> {
  const sourceFile = checker.service.getProgram()?.getSourceFile(abs);
  const callers = new Map<string, string[]>();
  if (!sourceFile) return callers;

  const identifiers: ts.Identifier[] = [];
  const collect = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.getStart(sourceFile) >= selectionStart &&
      node.end <= selectionEnd
    ) {
      identifiers.push(node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  for (const identifier of identifiers.slice(0, MAX_IDENTIFIERS)) {
    const pos = identifier.getStart(sourceFile);
    const definition = checker.service.getDefinitionAtPosition(abs, pos)?.[0];
    const declaredInside =
      definition !== undefined &&
      definition.fileName === abs &&
      definition.textSpan.start >= selectionStart &&
      definition.textSpan.start < selectionEnd;
    if (!declaredInside) continue;

    for (const ref of checker.service.getReferencesAtPosition(abs, pos) ?? []) {
      const inSelection =
        ref.fileName === abs &&
        ref.textSpan.start >= selectionStart &&
        ref.textSpan.start < selectionEnd;
      if (
        inSelection ||
        !isInside(workspace, ref.fileName) ||
        ref.fileName.includes("/node_modules/")
      ) {
        continue;
      }
      const list = callers.get(ref.fileName) ?? [];
      callers.set(ref.fileName, list);
      if (list.length >= SNIPPETS_PER_FILE) continue;
      const refLine = sourceFile.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1;
      const refText = readFileSync(ref.fileName, "utf-8");
      list.push(numberedRange(refText, refLine - SNIPPET_RADIUS, refLine + SNIPPET_RADIUS));
    }
  }
  return callers;
}
