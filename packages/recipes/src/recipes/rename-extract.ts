/**
 * rename-extract, rename part only. Renames a TypeScript identifier everywhere the language service says it is used.
 *
 * Input: a TypeScript file, a 1-based line and column on the identifier, and optionally the new name. The extract
 * part (turning a selection into a new function or variable) is NOT implemented in this pass.
 * Edits: the language service's findRenameLocations is deterministic, so the edits come from it, not from the model.
 * Model: used only when no new name is given. It proposes names, and each proposal is checked the same way.
 * Output: { newName } (a valid TypeScript identifier that is not a reserved word). The result also carries the full
 * text of each file the rename touches, before and after, so the caller applies exactly what was verified.
 * Layers: constrain (the name is a valid identifier, not the current name), verify (the type check of every touched
 * file shows no new error). A rename that reaches a file outside the workspace or inside node_modules is refused
 * before any check runs.
 *
 * Verifies: the name is a valid TypeScript identifier and differs from the current name; every touched file
 * type-checks with no error it did not have before (so a clash with an existing name in the same scope is caught).
 * Does NOT verify: that the rename preserves behavior; that shadowing which still type-checks keeps the same meaning;
 * that references the language service does not index (for example, in files outside the workspace) are renamed;
 * or that the proposed name is a good one (the model's choice is only checked for validity and for no new error).
 */
import { isInside } from "@fcx/apply";
import type { LayerOutcome } from "@fcx/defense";
import type { ModelHost } from "@fcx/model";
import { createTsChecker } from "@fcx/verify";
import ts from "typescript";
import * as z from "zod";
import { typeCheckLayer } from "../checks.js";
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

/** Versioned in prompts/rename-extract.md (promptVersion 1). A test keeps this constant identical to that file. */
export const RENAME_EXTRACT_SYSTEM = `You are a coding agent choosing a new name for a TypeScript identifier. Given the identifier, its type information, and the code around its declaration, propose a name that fits the code.

Constraints:
- The name must be a valid TypeScript identifier: letters, digits, underscore or dollar sign, not starting with a digit, and not a reserved word.
- Follow the naming style the code already uses: camelCase for values and functions, PascalCase for types and classes.
- Say what the identifier holds or does. Do not reuse a name already visible in the shown code.
- Do not return the current name.
- Output must be valid JSON matching the schema: { "newName": "..." }.
- Output only the name. Do not invent file paths or symbols.`;

export const RenameSchema = z.object({ newName: z.string().min(1) });
export type RenameOutput = z.infer<typeof RenameSchema>;

export const RENAME_EXTRACT_SCOPE: VerificationScope = {
  ran: ["ts-rename-locations (language service)", "ts-type-check"],
  notRun: [
    "extract (not implemented in this pass)",
    "behavior",
    "shadowing that still type-checks",
    "references the language service does not index",
  ],
};

const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Reserved words of the ECMAScript and TypeScript grammars, plus the strict-mode words that module code (which is
 * always strict) cannot use as bindings. Written out, because the TypeScript API does not export its keyword table.
 */
const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "await",
]);

/** True for a name a TypeScript identifier can have: the identifier pattern, and not a reserved word. */
export function isValidIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

export interface RenameExtractOptions {
  model: Pick<ModelHost, "generateObject" | "countTokens">;
  workspace: string;
  /** The TypeScript file, workspace-relative or absolute. */
  file: string;
  /** 1-based line of the identifier. */
  line: number;
  /** 1-based column of the identifier. */
  column: number;
  /** The new name. When omitted, the model proposes one. */
  newName?: string;
  /** Number of model candidates to try when proposing a name (plan §10: 4 on tier S, 6 on tier M). */
  maxCandidates: number;
  onLayer?: (event: LayerEvent) => void;
  /** The project instruction block (plan §12.2). Added to the user part of every candidate prompt. See src/instructions.ts. */
  instructions?: string;
}

export interface RenamedFile {
  /** Workspace-relative path. */
  file: string;
  /** The file text before the rename. The caller applies the rename only when the file still has this text. */
  baseText: string;
  /** The file text after the rename, as verified. */
  text: string;
}

export type RenameResult =
  | {
      status: "verified";
      symbol: string;
      newName: string;
      files: RenamedFile[];
      /** Number of references and declarations the language service renames. */
      locations: number;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    }
  | {
      status: "abstained";
      symbol: string;
      lastError: string;
      candidates: CandidateReport[];
      ms: number;
      instructionsTruncated: boolean;
      verification: VerificationScope;
    };

/** The spans one file's rename replaces, in the file's original text. */
interface FileSpans {
  file: string;
  base: string;
  spans: { start: number; length: number; prefix: string; suffix: string }[];
}

/** Runs the rename. Throws RecipeInputError for a bad position, a name that is not an identifier, or an unrenameable symbol. */
export async function runRenameExtract(options: RenameExtractOptions): Promise<RenameResult> {
  const t0 = performance.now();
  const workspace = options.workspace;
  const abs = absoluteIn(workspace, options.file);
  const rel = relativeTo(workspace, abs);
  if (!TS_FILE.test(abs)) {
    throw new RecipeInputError(`rename-extract supports TypeScript files only: ${rel}`);
  }
  const text = readText(abs);
  const lines = text.split("\n");
  const { line, column } = options;
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new RecipeInputError(`line ${line} is outside ${rel}`);
  }
  if (!Number.isInteger(column) || column < 1 || column > (lines[line - 1]?.length ?? 0) + 1) {
    throw new RecipeInputError(`column ${column} is outside line ${line} of ${rel}`);
  }
  const pos = lineOffset(text, line) + column - 1;
  if (options.newName !== undefined && !isValidIdentifier(options.newName)) {
    throw new RecipeInputError(`${options.newName} is not a valid TypeScript identifier`);
  }

  const checker = createTsChecker(workspace, abs);
  try {
    const info = checker.service.getRenameInfo(abs, pos);
    if (!info.canRename) {
      throw new RecipeInputError(
        info.localizedErrorMessage ||
          `the identifier at ${rel}:${line}:${column} cannot be renamed`,
      );
    }
    const current = info.displayName;
    if (options.newName !== undefined && options.newName === current) {
      throw new RecipeInputError(`the new name is the current name, ${current}`);
    }

    // `true` asks for prefix and suffix text, which shorthand properties need (`{ add }` becomes `{ add: sum }`).
    const locations = checker.service.findRenameLocations(abs, pos, false, false, true) ?? [];
    const byFile = new Map<string, FileSpans>();
    const seen = new Set<string>();
    for (const location of locations) {
      if (!isInside(workspace, location.fileName) || location.fileName.includes("/node_modules/")) {
        throw new RecipeInputError(
          `${current} is used outside the workspace (${relativeTo(workspace, location.fileName)}); rename it by hand`,
        );
      }
      const key = `${location.fileName}:${location.textSpan.start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let entry = byFile.get(location.fileName);
      if (!entry) {
        entry = { file: location.fileName, base: readText(location.fileName), spans: [] };
        byFile.set(location.fileName, entry);
      }
      entry.spans.push({
        start: location.textSpan.start,
        length: location.textSpan.length,
        prefix: location.prefixText ?? "",
        suffix: location.suffixText ?? "",
      });
    }
    const fileSpans = [...byFile.values()];
    const bases = new Map(fileSpans.map((f) => [f.file, f.base]));

    /** The new text of every touched file for `name`. Spans are applied from the end, so offsets stay valid. */
    const renameTo = (name: string): Map<string, string> => {
      const out = new Map<string, string>();
      for (const entry of fileSpans) {
        let next = entry.base;
        const ordered = [...entry.spans].sort((a, b) => b.start - a.start);
        for (const span of ordered) {
          next = `${next.slice(0, span.start)}${span.prefix}${name}${span.suffix}${next.slice(span.start + span.length)}`;
        }
        out.set(entry.file, next);
      }
      return out;
    };

    const nameLayer = (name: string): LayerOutcome => {
      if (!isValidIdentifier(name)) {
        return failure(
          "constrain",
          "INVALID_NAME",
          `${name} is not a valid TypeScript identifier. Use letters, digits, _ or $, do not start with a digit, and do not use a reserved word.`,
        );
      }
      if (name === current) {
        return failure(
          "constrain",
          "SAME_NAME",
          `The new name is the current name ${current}. Choose a different name.`,
        );
      }
      return { layer: "constrain", pass: true, ms: 0 };
    };

    const renameLayer = (name: string): { outcome: LayerOutcome; texts: Map<string, string> } => {
      const texts = renameTo(name);
      const outcome = typeCheckLayer({
        checker,
        workspace,
        texts,
        original: (path) => bases.get(path),
      });
      return { outcome, texts };
    };

    const filesOf = (texts: Map<string, string>): RenamedFile[] =>
      fileSpans.map((entry) => ({
        file: relativeTo(workspace, entry.file),
        baseText: entry.base,
        text: texts.get(entry.file) ?? entry.base,
      }));

    if (options.newName !== undefined) {
      // A given name needs no model: the language service and the type check decide.
      const layers: LayerOutcome[] = [];
      const valid = nameLayer(options.newName);
      layers.push(valid);
      let texts: Map<string, string> | undefined;
      if (valid.pass) {
        const attempt = renameLayer(options.newName);
        layers.push(attempt.outcome);
        if (attempt.outcome.pass) texts = attempt.texts;
      }
      const candidate: CandidateReport = {
        source: "compiler",
        temperature: 0,
        ms: elapsed(t0),
        pass: texts !== undefined,
        layers,
      };
      if (!texts) {
        return {
          status: "abstained",
          symbol: current,
          lastError: firstFeedback(layers),
          candidates: [candidate],
          ms: elapsed(t0),
          instructionsTruncated: false,
          verification: RENAME_EXTRACT_SCOPE,
        };
      }
      return {
        status: "verified",
        symbol: current,
        newName: options.newName,
        files: filesOf(texts),
        locations: locations.length,
        candidates: [candidate],
        ms: elapsed(t0),
        instructionsTruncated: false,
        verification: RENAME_EXTRACT_SCOPE,
      };
    }

    // No name given: the model proposes names, and each proposal goes through the same two checks.
    const quickInfo = checker.service.getQuickInfoAtPosition(abs, pos);
    const declared = quickInfo
      ? ts.displayPartsToString(quickInfo.displayParts)
      : "(no type information)";
    const verified: { name?: string; texts?: Map<string, string> } = {};
    const recipe: RecipeDefinition<RenameOutput> = {
      schema: RenameSchema,
      temperatures: CANDIDATE_TEMPERATURES,
      prompt: (feedback) => ({
        system: RENAME_EXTRACT_SYSTEM,
        user: [
          `Current name: ${current}`,
          `Type information: ${declared}`,
          `References: ${locations.length} in ${fileSpans.length} file(s)`,
          "",
          `Code of ${rel} around the identifier (line ${line}):`,
          numberedRange(text, line - 10, line + 10),
          ...(feedback ? ["", `Your previous attempt was rejected: ${feedback}`] : []),
        ].join("\n"),
      }),
      toEdits: () => [],
      layers: [
        {
          name: "constrain",
          check: ({ output }) => nameLayer(output?.newName ?? ""),
        },
        {
          name: "verify",
          check: ({ output }) => {
            const attempt = renameLayer(output?.newName ?? "");
            if (attempt.outcome.pass) {
              verified.name = output?.newName;
              verified.texts = attempt.texts;
            }
            return attempt.outcome;
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
    if (result.status === "verified" && verified.name !== undefined && verified.texts) {
      return {
        status: "verified",
        symbol: current,
        newName: verified.name,
        files: filesOf(verified.texts),
        locations: locations.length,
        candidates: result.candidates,
        ms,
        instructionsTruncated: result.instructionsTruncated,
        verification: RENAME_EXTRACT_SCOPE,
      };
    }
    return {
      status: "abstained",
      symbol: current,
      lastError:
        result.status === "abstained" ? result.lastError : "no candidate passed every check",
      candidates: result.candidates,
      ms,
      instructionsTruncated: result.instructionsTruncated,
      verification: RENAME_EXTRACT_SCOPE,
    };
  } finally {
    checker.dispose();
  }
}

function failure(
  layer: "constrain" | "verify",
  reasonCode: string,
  feedback: string,
): LayerOutcome {
  return { layer, pass: false, ms: 0, reasonCode, feedback };
}

/** The feedback of the first failing layer, or a fallback when every layer passed. */
function firstFeedback(layers: readonly LayerOutcome[]): string {
  for (const layer of layers) {
    if (!layer.pass) return layer.feedback;
  }
  return "no candidate passed every check";
}
