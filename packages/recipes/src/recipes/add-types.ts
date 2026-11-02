/**
 * add-types: adds explicit TypeScript type annotations to declarations that have none.
 *
 * Input: a TypeScript file (.ts, .tsx, .mts, .cts) and either a declaration name (`symbol`) or a 1-based inclusive
 * line range (`startLine`..`endLine`). Python is not supported in this pass.
 * Context: each target declaration with the type the language service reports for it (getQuickInfoAtPosition), and
 * the numbered code around the targets. Targets are declarations without an explicit type: variables, parameters,
 * properties, and functions or methods without a return type.
 * Output: { edits: Edit[] } over the one file. Edits are search/replace blocks anchored on exact text.
 * Layers: constrain (the file only), anchor, ground (every name in the changed lines resolves), verify (no new type
 * error in the file, and every target now has an explicit type that is not `any`).
 *
 * Verifies: the file has no type error that it did not have before; each target declaration has an explicit type
 * annotation after the edit (a return type for functions and methods); no target is annotated `any`.
 * Does NOT verify: that the annotation is the right type (only that the compiler accepts it); that other files still
 * type-check, since only the edited file is checked; that behavior is unchanged; or that a target declared more than
 * once by the same name is the one meant (a `symbol` names every undeclared-type declaration with that name).
 */
import type { Edit } from "@fcx/apply";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { createTsChecker } from "@fcx/verify";
import ts from "typescript";
import { type LineSpan, groundLayer, typeCheckLayer } from "../checks.js";
import { RecipeInputError, absoluteIn, numberedRange, readText, relativeTo } from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  editsSchema,
  elapsed,
  requireWork,
  runRecipeEngine,
} from "../engine.js";

/** Versioned in prompts/add-types.md (promptVersion 1). A test keeps this constant identical to that file. */
export const ADD_TYPES_SYSTEM = `You are a coding agent adding explicit TypeScript type annotations. Given a file, the declarations to annotate (each with the type the TypeScript compiler reports for it), and the code around them, produce search/replace edits that add the annotations.

Constraints:
- Edit only the file named in the allowed files list.
- Annotate only the declarations listed as targets. Do not change names, logic, or behavior.
- Use a precise type. Do not use any, unknown, or a type assertion. The compiler's reported type is a good answer when it is correct.
- Only reference types in scope: built-in types, types declared or imported in the file, or types shown in the context. Do not invent type names or import paths.
- Each search string must match exactly once in the current file (after line-ending normalization).
- Output must be valid JSON matching the schema: { "edits": [{ "file": "...", "search": "...", "replace": "..." }] }.
- Use minimal, targeted search/replace blocks. Do not rewrite whole files.`;

export const AddTypesSchema = editsSchema(4);
export type AddTypesOutput = { edits: Edit[] };

export const ADD_TYPES_SCOPE: VerificationScope = {
  ran: ["edit-apply", "ts-ground", "ts-type-check", "ts-annotation-check"],
  notRun: ["annotation correctness", "other files' type check", "behavior"],
};

const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;

/** A declaration that may carry a type annotation. `ordinal` numbers same-named declarations in file order. */
interface NamedDeclaration {
  name: string;
  ordinal: number;
  /** 1-based line of the name. */
  line: number;
  /** Offset of the name in the file. */
  pos: number;
  /** Whether the declaration has an explicit type (a return type for functions and methods). */
  typed: boolean;
  /** Whether that explicit type is the keyword `any`. */
  anyType: boolean;
}

export interface AddTypesOptions {
  model: Pick<ModelHost, "generateObject">;
  workspace: string;
  /** The TypeScript file, workspace-relative or absolute. */
  file: string;
  /** A declaration name in the file. Give either this or the line range. */
  symbol?: string;
  /** 1-based inclusive first line of the range. Give either this or `symbol`. */
  startLine?: number;
  /** 1-based inclusive last line of the range. */
  endLine?: number;
  /** Number of model candidates to try (plan §10: 4 on tier S, 6 on tier M). */
  maxCandidates: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type AddTypesResult =
  | { status: "nothing-to-annotate"; file: string; ms: number }
  | {
      status: "verified";
      /** Workspace-relative path of the edited file. */
      file: string;
      /** The annotated declarations, as `name@line`. */
      annotated: string[];
      edits: Edit[];
      /** The full file text the edits were verified against. */
      text: string;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      file: string;
      annotated: string[];
      lastError: string;
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** Runs the add-types recipe. Throws RecipeInputError for a non-TypeScript file, a bad target, or a missing symbol. */
export async function runAddTypes(options: AddTypesOptions): Promise<AddTypesResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const rel = relativeTo(workspace, abs);
  if (!TS_FILE.test(abs)) {
    throw new RecipeInputError(`add-types supports TypeScript files only: ${rel}`);
  }
  const text = readText(abs);
  const lineCount = text.split("\n").length;

  const hasSymbol = options.symbol !== undefined;
  const hasRange = options.startLine !== undefined || options.endLine !== undefined;
  if (hasSymbol === hasRange) {
    throw new RecipeInputError("give either a symbol or a line range, not both and not neither");
  }
  let range: LineSpan | undefined;
  if (hasRange) {
    const first = options.startLine;
    const last = options.endLine;
    if (
      first === undefined ||
      last === undefined ||
      !Number.isInteger(first) ||
      !Number.isInteger(last) ||
      first < 1 ||
      last < first ||
      last > lineCount
    ) {
      throw new RecipeInputError(`invalid line range for ${rel}`);
    }
    range = { first, last };
  }

  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const declarations = listDeclarations(sourceFile);
  if (options.symbol !== undefined && !declarations.some((d) => d.name === options.symbol)) {
    throw new RecipeInputError(`no declaration named ${options.symbol} in ${rel}`);
  }
  const targets = declarations.filter(
    (d) =>
      !d.typed &&
      (options.symbol !== undefined
        ? d.name === options.symbol
        : range !== undefined && d.line >= range.first && d.line <= range.last),
  );
  if (targets.length === 0) {
    return { status: "nothing-to-annotate", file: rel, ms: elapsed(t0) };
  }

  const checker = createTsChecker(workspace, abs);
  try {
    const typeInfo = targets.map((target) => {
      const info = checker.service.getQuickInfoAtPosition(abs, target.pos);
      const detail = info ? ts.displayPartsToString(info.displayParts) : "(no type information)";
      return `- ${target.name} (line ${target.line}): ${detail}`;
    });
    const firstLine = Math.min(...targets.map((t) => t.line));
    const lastLine = Math.max(...targets.map((t) => t.line));
    const codeWindow = numberedRange(text, firstLine - 20, lastLine + 20);
    const annotated = targets.map((t) => `${t.name}@${t.line}`);

    const recipe: RecipeDefinition<AddTypesOutput> = {
      schema: AddTypesSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: ADD_TYPES_SYSTEM,
        user: [
          `Allowed files: ${rel}`,
          "",
          "Declarations to annotate, with the type the compiler reports:",
          ...typeInfo,
          "",
          `Code of ${rel} around the targets:`,
          codeWindow,
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
          check: ({ texts, original }) => {
            const types = typeCheckLayer({ checker, workspace, texts, original });
            if (!types.pass) return types;
            const candidate = texts.get(abs) ?? text;
            return annotationLayer(candidate, targets);
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
    const ms = elapsed(t0);
    if (result.status === "verified") {
      return {
        status: "verified",
        file: rel,
        annotated,
        edits: result.edits,
        text: result.texts.get(abs) ?? text,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: ADD_TYPES_SCOPE,
      };
    }
    return {
      status: "abstained",
      file: rel,
      annotated,
      lastError: result.lastError,
      bestCandidate: result.bestCandidate,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: ADD_TYPES_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

/** Every declaration in the file that can carry a type annotation, in source order. */
function listDeclarations(sourceFile: ts.SourceFile): NamedDeclaration[] {
  const found: NamedDeclaration[] = [];
  const ordinals = new Map<string, number>();
  const add = (nameNode: ts.Identifier, typeNode: ts.TypeNode | undefined): void => {
    const name = nameNode.text;
    const ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    const pos = nameNode.getStart(sourceFile);
    found.push({
      name,
      ordinal,
      line: sourceFile.getLineAndCharacterOfPosition(pos).line + 1,
      pos,
      typed: typeNode !== undefined,
      anyType: typeNode?.kind === ts.SyntaxKind.AnyKeyword,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name, node.type);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
      add(node.name, node.type);
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      add(node.name, node.type);
    } else if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      add(node.name, node.type);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * The annotation layer: every target, found again by name and ordinal, must now have an explicit type that is not
 * `any`. A target that has disappeared is a failure too, since the candidate must annotate in place.
 */
function annotationLayer(candidate: string, targets: readonly NamedDeclaration[]): LayerOutcome {
  const t0 = performance.now();
  const after = listDeclarations(
    ts.createSourceFile("candidate.ts", candidate, ts.ScriptTarget.Latest, true),
  );
  for (const target of targets) {
    const now = after.find((d) => d.name === target.name && d.ordinal === target.ordinal);
    if (!now) {
      return {
        layer: "verify",
        pass: false,
        ms: elapsed(t0),
        reasonCode: "TARGET_MISSING",
        feedback: `The declaration ${target.name} is gone or was renamed. Keep the declarations and add the annotations in place.`,
      };
    }
    if (!now.typed) {
      return {
        layer: "verify",
        pass: false,
        ms: elapsed(t0),
        reasonCode: "NOT_ANNOTATED",
        feedback: `${target.name} at line ${now.line} still has no explicit type. Add a type annotation to its declaration.`,
      };
    }
    if (now.anyType) {
      return {
        layer: "verify",
        pass: false,
        ms: elapsed(t0),
        reasonCode: "ANY_TYPE",
        feedback: `${target.name} at line ${now.line} is annotated any. Use a precise type.`,
      };
    }
  }
  return { layer: "verify", pass: true, ms: elapsed(t0) };
}
