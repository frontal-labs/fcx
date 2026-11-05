/**
 * docstring: writes a JSDoc block for one TypeScript declaration and inserts it above the declaration.
 *
 * Input: a TypeScript file and a 1-based line inside the declaration. The declaration is the innermost top-level,
 * class-member or interface-member declaration that contains the line (functions, classes, methods, variables,
 * interfaces, type aliases, enums, properties, accessors).
 * Context: the declaration's code and the numbered lines around it.
 * Output: { doc: string }, a JSDoc block with no code in it. The edit inserts the block on the line above the
 * declaration, indented like it, as a search/replace block anchored on the declaration's exact text.
 * Layers: constrain (the file, and the doc is one comment block with no code fence or code line), anchor, verify
 * (the inserted text is a comment that attaches to the declaration, and the declaration and the rest of the file are
 * unchanged).
 *
 * Verifies: the doc is a single JSDoc block that starts with the opening delimiter and ends with the closing one, has
 * no code fence, and has no line that is code; it parses as a comment attached to the declaration; the declaration's
 * text is unchanged after insertion, and nothing else in the file changed.
 * Does NOT verify: that the doc describes the code accurately or completely. The doc lint is not configured in this
 * repository, so no lint runs. The type check is not run either, because a comment cannot change types.
 * Refuses a declaration that already has a JSDoc block, rather than adding a second one.
 */
import type { Edit } from "@fcx/apply";
import { type LayerOutcome, constrain } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import ts from "typescript";
import * as z from "zod";
import {
  RecipeInputError,
  absoluteIn,
  lineOffset,
  numberedRange,
  readText,
  relativeTo,
} from "../context.js";
import {
  CANDIDATE_TEMPERATURES,
  type CandidateReport,
  type LayerEvent,
  type RecipeDefinition,
  type VerificationScope,
  elapsed,
  requireWork,
  runRecipeEngine,
} from "../engine.js";

/** Versioned in prompts/docstring.md (promptVersion 1). A test keeps this constant identical to that file. */
export const DOCSTRING_SYSTEM = `You are a coding agent writing documentation for a TypeScript declaration. Given the declaration and the code around it, write its JSDoc block.

Constraints:
- Output only a JSDoc block. It starts with a line that begins with a slash and two asterisks and ends with a line that is a single asterisk and a slash. Every line in between starts with an asterisk.
- Output no code, no code fences, and no copy of the declaration.
- Start with one summary sentence that says what the declaration does. Add a parameter tag for each parameter that exists, and a return tag only when the declaration returns a value.
- Be accurate to the code shown. Do not invent behavior, options, thrown errors, or symbols.
- Keep it short. Add tags only where they add information.
- Output must be valid JSON matching the schema: { "doc": "..." }.`;

export const DocstringSchema = z.object({ doc: z.string().min(1) });

const CODE_START =
  /^(const|let|var|return|function|import|export|if|for|while|class|type|interface)\b/;

/** True when every non-blank line reads as words, not code: no code punctuation and no code keyword at its start. */
export function isProse(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.length > 0 && lines.every((line) => !/[;{}()=]/.test(line) && !CODE_START.test(line))
  );
}

/**
 * Tidies a model's doc text when it is one JSDoc block wrapped in code fences, or written on one line. The fence
 * lines are dropped and each inner line is indented to sit under the opening delimiter. A line without a leading
 * asterisk is left as written, so the constrain check still sees it. A one-line block is returned as written. Anything else is returned trimmed and unchanged,
 * so the constrain check rejects it with its own reason (text around the block, code, a second block).
 */
export function extractDocBlock(raw: string): string {
  const text = raw
    .replace(/^\s*(```|~~~)[^\n]*\n?/gm, "")
    .replace(/\n?\s*(```|~~~)\s*$/gm, "")
    .trim();
  if (!text.includes("/**") && !text.includes("*/") && isProse(text)) {
    // The model wrote the comment text without its delimiters. Each line becomes a line of the block.
    const lines = text.split("\n").map((line) => line.trim().replace(/^\*\s?/, ""));
    const body = lines.map((line) => (line === "" ? " *" : ` * ${line}`));
    return ["/**", ...body, " */"].join("\n");
  }
  if (
    text.length < 2 ||
    !text.startsWith("/**") ||
    !text.endsWith("*/") ||
    text.indexOf("*/") !== text.length - 2
  ) {
    return text;
  }
  // A one-line block is already valid as written.
  if (!text.includes("\n")) return text;
  const body = text
    .slice(3, -2)
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, all) => !(line === "" && (i === 0 || i === all.length - 1)))
    .map((line) => (line === "" ? " *" : line.startsWith("*") ? ` ${line}` : line));
  return ["/**", ...(body.length === 0 ? [" *"] : body), " */"].join("\n");
}
export type DocstringOutput = z.infer<typeof DocstringSchema>;

export const DOCSTRING_SCOPE: VerificationScope = {
  ran: ["edit-apply", "doc-format", "comment-attachment", "declaration-unchanged"],
  notRun: ["doc lint (not configured in this repository)", "doc accuracy", "type check"],
};

/** Longest doc block accepted, in characters. */
const MAX_DOC_CHARS = 4000;
/** Lines of code shown on each side of the declaration. */
const CONTEXT_LINES = 15;

const DOCUMENTABLE = (node: ts.Node): boolean =>
  ts.isFunctionDeclaration(node) ||
  ts.isClassDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isConstructorDeclaration(node) ||
  ts.isGetAccessorDeclaration(node) ||
  ts.isSetAccessorDeclaration(node) ||
  ts.isPropertyDeclaration(node) ||
  ts.isPropertySignature(node) ||
  ts.isMethodSignature(node) ||
  ts.isInterfaceDeclaration(node) ||
  ts.isTypeAliasDeclaration(node) ||
  ts.isEnumDeclaration(node) ||
  ts.isVariableStatement(node);

export interface DocstringOptions {
  model: Pick<ModelHost, "generateObject" | "countTokens">;
  workspace: string;
  /** The TypeScript file, workspace-relative or absolute. */
  file: string;
  /** 1-based line inside the declaration to document. */
  line: number;
  /** Number of model candidates to try (plan §10: 4 on tier S, 6 on tier M). */
  maxCandidates: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export type DocstringResult =
  | {
      status: "verified";
      /** Workspace-relative path of the file the edit applies to. */
      file: string;
      /** 1-based line the doc block is inserted above. */
      line: number;
      doc: string;
      edits: Edit[];
      /** The full file text the edit was verified against, with the doc block inserted. */
      text: string;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      file: string;
      line: number;
      lastError: string;
      bestCandidate?: Edit[];
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** Runs the docstring recipe. Throws RecipeInputError when no declaration is at the line, or it is already documented. */
export async function runDocstring(options: DocstringOptions): Promise<DocstringResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const rel = relativeTo(workspace, abs);
  const text = readText(abs);
  const lineCount = text.split("\n").length;
  if (!Number.isInteger(options.line) || options.line < 1 || options.line > lineCount) {
    throw new RecipeInputError(`line ${options.line} is outside ${rel}`);
  }

  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true);
  const node = declarationAt(sourceFile, options.line);
  if (!node) {
    throw new RecipeInputError(`no declaration at ${rel}:${options.line}`);
  }
  const start = node.getStart(sourceFile);
  const declText = text.slice(start, node.end);
  const startLine = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
  const indent = text.slice(lineOffset(text, startLine), start);
  if (!/^[ \t]*$/.test(indent)) {
    throw new RecipeInputError(
      `the declaration at ${rel}:${startLine} shares its line with other code`,
    );
  }
  if (
    ts
      .getLeadingCommentRanges(text, node.getFullStart())
      ?.some((range) => text.slice(range.pos, range.end).startsWith("/**"))
  ) {
    throw new RecipeInputError(`${rel}:${startLine} already has a doc comment`);
  }
  if (text.split(declText).length - 1 !== 1) {
    throw new RecipeInputError(
      `the text of the declaration at ${rel}:${startLine} is not unique in the file`,
    );
  }

  const kind = node.kind;
  const replacementFor = (doc: string): string => `${docBlock(doc, indent)}\n${indent}${declText}`;

  const recipe: RecipeDefinition<DocstringOutput> = {
    schema: DocstringSchema,
    normalize: (output) => ({ doc: extractDocBlock(output.doc) }),
    temperatures: CANDIDATE_TEMPERATURES,
    prompt: (feedback) => ({
      system: DOCSTRING_SYSTEM,
      user: [
        `Allowed files: ${rel}`,
        `Declaration to document: ${rel}:${startLine}-${endLine}`,
        "",
        "Declaration:",
        declText,
        "",
        `Code of ${rel} around it:`,
        numberedRange(text, startLine - CONTEXT_LINES, endLine + CONTEXT_LINES),
        ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
      ].join("\n"),
    }),
    toEdits: (output) => [{ file: rel, search: declText, replace: replacementFor(output.doc) }],
    layers: [
      {
        name: "constrain",
        check: (input) => {
          const files = constrain(input.edits, input.bundle);
          if (!files.pass) return files;
          return docFormat(input.output?.doc ?? "");
        },
      },
      { name: "anchor" },
      {
        name: "verify",
        check: ({ output, texts }) => {
          const t = performance.now();
          const doc = output?.doc ?? "";
          const candidate = texts.get(abs) ?? text;
          const docText = docBlock(doc, indent);
          const expected = `${text.slice(0, start)}${replacementFor(doc)}${text.slice(start + declText.length)}`;
          if (candidate !== expected) {
            return verifyFail(
              t,
              "CONTENT_CHANGED",
              "The edit changed text other than the doc block insertion.",
            );
          }
          const newStart = start + docText.length + 1 + indent.length;
          const candidateSource = ts.createSourceFile(abs, candidate, ts.ScriptTarget.Latest, true);
          const after = declarationStartingAt(candidateSource, newStart, kind, declText);
          if (!after) {
            return verifyFail(
              t,
              "DECLARATION_CHANGED",
              "The declaration's text changed after inserting the doc block.",
            );
          }
          const attached = ts
            .getLeadingCommentRanges(candidate, after.getFullStart())
            ?.some((range) => candidate.slice(range.pos, range.end) === docText);
          if (!attached) {
            return verifyFail(
              t,
              "DOC_NOT_ATTACHED",
              "The doc block is not a comment directly above the declaration. Output only the JSDoc block.",
            );
          }
          return { layer: "verify", pass: true, ms: elapsed(t) };
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
      countTokens: options.model.countTokens,
      onLayer: options.onLayer,
      instructions: options.instructions,
    }),
  );
  const ms = elapsed(t0);
  if (result.status === "verified") {
    return {
      status: "verified",
      file: rel,
      line: startLine,
      doc: result.output?.doc ?? "",
      edits: result.edits,
      text: result.texts.get(abs) ?? text,
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: DOCSTRING_SCOPE,
    };
  }
  return {
    status: "abstained",
    file: rel,
    line: startLine,
    lastError: result.lastError,
    bestCandidate: result.bestCandidate,
    candidates: result.candidates,
    ms,
    instructionsTruncated: result.instructionsTruncated,
    verification: DOCSTRING_SCOPE,
  };
}

/**
 * The innermost documentable declaration that contains `line`. Only declarations directly in the file, in a module
 * block, in a class or in an interface count, so a line inside a function body documents the function.
 */
function declarationAt(sourceFile: ts.SourceFile, line: number): ts.Node | undefined {
  let best: ts.Node | undefined;
  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (node: ts.Node): void => {
    if (DOCUMENTABLE(node) && isDirectMember(node)) {
      const first = lineOf(node.getStart(sourceFile));
      const last = lineOf(node.end);
      if (first <= line && line <= last) {
        if (!best || node.end - node.getStart(sourceFile) < best.end - best.getStart(sourceFile)) {
          best = node;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return best;
}

function isDirectMember(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isSourceFile(parent) ||
    ts.isModuleBlock(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isClassExpression(parent) ||
    ts.isInterfaceDeclaration(parent)
  );
}

/** The declaration of `kind` whose text is `declText` and which starts at `pos`, or undefined. */
function declarationStartingAt(
  sourceFile: ts.SourceFile,
  pos: number,
  kind: ts.SyntaxKind,
  declText: string,
): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      node.kind === kind &&
      node.getStart(sourceFile) === pos &&
      node.getText(sourceFile) === declText
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** The doc block with each line indented to sit above a declaration at `indent`. */
function docBlock(doc: string, indent: string): string {
  const lines = doc
    .trim()
    .split("\n")
    .map((line) => line.trim());
  return lines
    .map((line, i) => {
      if (i === 0) return line;
      if (line === "") return `${indent} *`;
      if (line.startsWith("*")) return `${indent} ${line}`;
      return `${indent} * ${line}`;
    })
    .join("\n");
}

/** Constrain check on the doc text: one JSDoc block, no code fence, and no line that is code. */
function docFormat(doc: string): LayerOutcome {
  const fail = (reasonCode: string, feedback: string): LayerOutcome => ({
    layer: "constrain",
    pass: false,
    ms: 0,
    reasonCode,
    feedback,
  });
  const trimmed = doc.trim();
  if (trimmed.length > MAX_DOC_CHARS) {
    return fail(
      "DOC_TOO_LONG",
      `The doc block is longer than ${MAX_DOC_CHARS} characters. Shorten it.`,
    );
  }
  if (
    !trimmed.startsWith("/**") ||
    !trimmed.endsWith("*/") ||
    trimmed.length < 2 ||
    trimmed.indexOf("*/") !== trimmed.length - 2
  ) {
    return fail(
      "DOC_NOT_BLOCK",
      "Output one JSDoc block that starts with the opening delimiter and ends with the closing delimiter, and nothing else.",
    );
  }
  if (/```|~~~/.test(trimmed)) {
    return fail(
      "DOC_CODE_FENCE",
      "The doc block contains a code fence. Remove it and output only comment text.",
    );
  }
  for (const raw of trimmed.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("/**") || line.startsWith("*")) continue;
    return fail(
      "DOC_LINE_NOT_COMMENT",
      `The line "${line.slice(0, 120)}" is not comment text. Every line inside the JSDoc block starts with an asterisk. Output only the JSDoc block.`,
    );
  }
  return { layer: "constrain", pass: true, ms: 0 };
}

function verifyFail(t: number, reasonCode: string, feedback: string): LayerOutcome {
  return { layer: "verify", pass: false, ms: elapsed(t), reasonCode, feedback };
}
