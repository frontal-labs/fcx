import type { Checker, Diagnostic } from "@fcx/verify";
import ts from "typescript";
import { BUILTIN_GLOBALS } from "./builtins.js";
import { nearestNames } from "./levenshtein.js";
import type { LayerOutcome } from "./types.js";
import { fail, timed } from "./util.js";

/*
 * Layer 2: every name the candidate uses must resolve.
 *
 * For TypeScript this overlaps with the verify layer: the same checker reports the same unresolved names.
 * `ground` exists so the feedback names the identifier and suggests the nearest in-scope names, which a
 * raw compiler message does not do well. It only reports name-resolution diagnostics and does not change the
 * verify layer's behavior.
 *
 * Only diagnostics inside the changed lines are reported, so names that were already broken before the edit
 * are not blamed on the candidate. A pure deletion has no changed lines here and passes; verify catches the
 * references it leaves behind.
 */

/** Codes for a name that does not resolve (2304, 2552 with a hint, 2584/2580/2582 missing lib or types, 2305 bad import). */
const IDENTIFIER_CODES = new Set([2304, 2552, 2580, 2582, 2584, 2305]);
/** Codes for a property that does not exist on a known type (2339, 2551 with a hint). */
const MEMBER_CODES = new Set([2339, 2551]);
const IDENTIFIER_MESSAGE = /(?:Cannot find name|has no exported member) '([^']+)'/;
const MEMBER_MESSAGE = /Property '([^']+)' does not exist on type/;
const TS_FILE = /\.(?:ts|tsx|mts|cts)$/;

interface Unresolved {
  name: string;
  kind: "identifier" | "member";
  diagnostic: Diagnostic;
}

export function ground(options: {
  checker: Checker;
  /** Absolute path of the file the candidate edits. */
  file: string;
  /** The file text before the edit. */
  originalText: string;
  /** The file text with the candidate applied. */
  candidateText: string;
}): LayerOutcome {
  const [outcome, ms] = timed((): LayerOutcome => {
    const passed: LayerOutcome = { layer: "ground", pass: true, ms: 0 };
    if (!TS_FILE.test(options.file)) return passed;

    const region = changedLines(options.originalText, options.candidateText);
    if (!region) return passed;

    const diagnostics = options.checker
      .diagnostics(options.file, new Map([[options.file, options.candidateText]]))
      .filter((d) => d.category === "error" && d.line >= region.first && d.line <= region.last)
      .sort((a, b) => a.line - b.line || a.column - b.column);

    const program = options.checker.service.getProgram();
    const sourceFile = program?.getSourceFile(options.file);
    const typeChecker = program?.getTypeChecker();

    for (const diagnostic of diagnostics) {
      const unresolved = unresolvedName(diagnostic);
      if (!unresolved || BUILTIN_GLOBALS.has(unresolved.name)) continue;
      const node =
        sourceFile && typeChecker
          ? identifierAt(
              sourceFile,
              ts.getPositionOfLineAndCharacter(
                sourceFile,
                diagnostic.line - 1,
                diagnostic.column - 1,
              ),
            )
          : undefined;

      if (unresolved.kind === "member") {
        const access = node?.parent;
        const type =
          typeChecker && access && ts.isPropertyAccessExpression(access) && access.name === node
            ? typeChecker.getTypeAtLocation(access.expression)
            : undefined;
        const typeName = type && typeChecker ? typeChecker.typeToString(type) : "unknown";
        const suggestions = type
          ? nearestNames(
              unresolved.name,
              type.getProperties().map((p) => p.getName()),
            )
          : [];
        return fail(
          "ground",
          "UNKNOWN_MEMBER",
          memberFeedback(unresolved.name, typeName, suggestions),
        );
      }

      const suggestions =
        node && typeChecker
          ? nearestNames(
              unresolved.name,
              typeChecker
                .getSymbolsInScope(
                  node,
                  ts.SymbolFlags.Value |
                    ts.SymbolFlags.Type |
                    ts.SymbolFlags.Namespace |
                    ts.SymbolFlags.Alias,
                )
                .map((s) => s.getName())
                .filter((n) => !n.startsWith("__")),
            )
          : [];
      return fail("ground", "UNKNOWN_IDENTIFIER", identifierFeedback(unresolved.name, suggestions));
    }
    return passed;
  });
  return { ...outcome, ms };
}

/** The 1-based inclusive line range of the candidate that differs from the original, or undefined if none. */
export function changedLines(
  original: string,
  candidate: string,
): { first: number; last: number } | undefined {
  const a = original.split("\n");
  const b = candidate.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const first = prefix + 1;
  const last = b.length - suffix;
  return last < first ? undefined : { first, last };
}

function unresolvedName(diagnostic: Diagnostic): Unresolved | undefined {
  if (IDENTIFIER_CODES.has(diagnostic.code)) {
    const name = IDENTIFIER_MESSAGE.exec(diagnostic.message)?.[1];
    return name ? { name, kind: "identifier", diagnostic } : undefined;
  }
  if (MEMBER_CODES.has(diagnostic.code)) {
    const name = MEMBER_MESSAGE.exec(diagnostic.message)?.[1];
    return name ? { name, kind: "member", diagnostic } : undefined;
  }
  return undefined;
}

/** The identifier that starts at `pos`, found by walking the parsed tree. */
function identifierAt(sourceFile: ts.SourceFile, pos: number): ts.Identifier | undefined {
  let found: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (found || pos < node.getStart(sourceFile) || pos >= node.end) return;
    if (ts.isIdentifier(node) && node.getStart(sourceFile) === pos) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function identifierFeedback(name: string, suggestions: readonly string[]): string {
  if (suggestions.length === 0) {
    return `Unknown identifier '${name}'. Define it or import it before use.`;
  }
  return `Unknown identifier '${name}'. Did you mean: ${suggestions.join(", ")}?`;
}

function memberFeedback(name: string, typeName: string, suggestions: readonly string[]): string {
  const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  return `Unknown member '${name}' on type '${typeName}'.${hint}`;
}
