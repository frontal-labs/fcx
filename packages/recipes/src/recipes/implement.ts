/**
 * implement: writes the body of a stub function from its signature and documentation.
 *
 * Input: a file and a 1-based line inside the stub function (its signature or body).
 * Context: the stub's signature and JSDoc, plus the blocks retrieval ranks around it (callers, used types).
 * Output: { body }, the statements inside the braces. The engine replaces the whole declaration with
 * `signature { body }`, anchored on the stub's exact text.
 * Layers: constrain (the stub's own file), anchor, ground (every identifier in the new body resolves in scope), verify
 * (no error inside the new function, and no new error in the file).
 *
 * Verifies: the new body type-checks against the signature; identifiers resolve in the file's scope, so a body that
 * uses an out-of-scope name is rejected; the rest of the file gains no type error.
 * Does NOT verify: that the body does what its doc says, that linked tests pass, or that the function is called
 * correctly. Only function declarations and methods with a block body are supported.
 */
import type { Edit } from "@fcx/apply";
import type { ModelHost } from "@fcx/model";
import { retrieve } from "@fcx/retrieve";
import { createTsChecker } from "@fcx/verify";
import ts from "typescript";
import * as z from "zod";
import { type LineSpan, groundLayer, typeCheckLayer } from "../checks.js";
import { RecipeInputError, absoluteIn, readText, relativeTo, renderBlocks } from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  requireWork,
  runRecipeEngine,
} from "../engine.js";
import { IMPLEMENT_SYSTEM } from "../prompts.js";

export const ImplementSchema = z.object({ body: z.string().min(1) });
export type ImplementOutput = z.infer<typeof ImplementSchema>;

export const IMPLEMENT_SCOPE: VerificationScope = {
  ran: ["edit-apply", "ts-ground", "ts-type-check"],
  notRun: ["linked-tests", "doc-conformance"],
};

export interface ImplementOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The file that declares the stub, workspace-relative or absolute. */
  file: string;
  /** 1-based line inside the stub function. */
  line: number;
  /** Index database used by retrieval. Created when missing. */
  indexPath: string;
  maxCandidates: number;
  contextBudgetTokens?: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type ImplementResult =
  | {
      status: "verified";
      edits: Edit[];
      /** The new text of the whole declaration. */
      replacement: string;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      lastError: string;
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** Runs the implement recipe. Throws RecipeInputError when no function with a block body is at the line. */
export async function runImplement(options: ImplementOptions): Promise<ImplementResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const text = readText(abs);
  const rel = relativeTo(workspace, abs);

  const checker = createTsChecker(workspace, abs);
  try {
    const sourceFile = checker.service.getProgram()?.getSourceFile(abs);
    if (!sourceFile) throw new RecipeInputError(`cannot parse ${rel}`);
    const stub = findStub(sourceFile, options.line);
    if (!stub?.body) {
      throw new RecipeInputError(`no function with a block body at ${rel}:${options.line}`);
    }
    const body = stub.body;
    const declStart = stub.getStart(sourceFile);
    const declText = text.slice(declStart, stub.end);
    const bodyOffset = body.getStart(sourceFile) - declStart;
    const signature = declText.slice(0, bodyOffset).trimEnd();
    const doc = text.slice(stub.getFullStart(), declStart).trim();
    const startLine = sourceFile.getLineAndCharacterOfPosition(declStart).line + 1;

    const bundle = await retrieve(
      { workspace, file: abs, line: startLine },
      { dbPath: options.indexPath, contextBudgetTokens: options.contextBudgetTokens },
    );
    const context = bundle.blocks.filter((b) => b.why !== "target symbol");

    const recipe: RecipeDefinition<ImplementOutput> = {
      schema: ImplementSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: IMPLEMENT_SYSTEM,
        user: [
          `Allowed files: ${rel}`,
          `Function to implement: ${rel}:${startLine}`,
          "",
          "Documentation and signature:",
          doc ? `${doc}\n${signature}` : signature,
          "",
          "Stub:",
          declText,
          "",
          "Related code (callers, used types):",
          renderBlocks(context),
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: (output) => [
        { file: rel, search: declText, replace: replacementFor(declText, bodyOffset, output.body) },
      ],
      layers: [
        { name: "constrain" },
        { name: "anchor" },
        { name: "ground", check: ({ texts, original }) => groundLayer(checker, texts, original) },
        {
          name: "verify",
          check: ({ output, texts, original }) => {
            const lines = output
              ? replacementFor(declText, bodyOffset, output.body).split("\n").length
              : 1;
            const spans = new Map<string, LineSpan>([
              [abs, { first: startLine, last: startLine + lines - 1 }],
            ]);
            return typeCheckLayer({ checker, workspace, texts, original, spans });
          },
        },
      ],
    };

    const result = requireWork(
      await runRecipeEngine({
        recipe,
        model: options.model,
        workspace,
        allowedFiles: [abs],
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
        replacement: result.edits[0]?.replace ?? "",
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: IMPLEMENT_SCOPE,
      };
    }
    return {
      status: "abstained",
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: IMPLEMENT_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/** The innermost function declaration or method with a block body that contains `line`. */
function findStub(
  sourceFile: ts.SourceFile,
  line: number,
): ts.FunctionDeclaration | ts.MethodDeclaration | undefined {
  let best: ts.FunctionDeclaration | ts.MethodDeclaration | undefined;
  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.body !== undefined &&
      lineOf(node.getStart(sourceFile)) <= line &&
      line <= lineOf(node.end)
    ) {
      const current = best;
      if (
        !current ||
        node.end - node.getStart(sourceFile) < current.end - current.getStart(sourceFile)
      ) {
        best = node;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best;
}

/** The declaration with its body replaced by `{ body }`. The signature and everything before the body stay as they are. */
function replacementFor(declText: string, bodyOffset: number, body: string): string {
  return `${declText.slice(0, bodyOffset)}{\n${body}\n}`;
}
