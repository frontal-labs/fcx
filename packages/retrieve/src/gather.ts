import { relative } from "node:path";
import {
  block,
  declarationAt,
  enclosingScope,
  identifiersIn,
  insideRange,
  tokenAt,
} from "./ast.js";
import {
  DEFAULT_BUDGET_CHARS,
  MAX_DEFINITIONS,
  MAX_DEFINITION_LINES,
  MAX_ENCLOSING_LINES,
} from "./constants.js";
import { isInside, isLibrary } from "./filter.js";
import type { ContextBlock, FixContext, GatherOptions } from "./types.js";

/**
 * Gathers the code a fix needs: the smallest enclosing function or class, and the
 * declarations of the identifiers it uses (one hop, through the TypeScript checker).
 * Library declarations are skipped; they are not part of the project being edited.
 */
export function gatherFixContext(opts: GatherOptions): FixContext {
  const program = opts.checker.service.getProgram();
  const source = program?.getSourceFile(opts.file);
  if (!program || !source) return { enclosing: null, definitions: [] };

  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const pos = source.getPositionOfLineAndCharacter(
    Math.max(0, opts.line - 1),
    Math.max(0, opts.column - 1),
  );
  const token = tokenAt(source, pos);
  const scope = enclosingScope(token ?? source, source);
  const rel = relative(opts.workspace, opts.file);

  const enclosing = block(source, scope, rel, "enclosing scope", MAX_ENCLOSING_LINES);
  let used = enclosing.text.length;
  const definitions: ContextBlock[] = [];
  const seen = new Set<string>();

  for (const identifier of identifiersIn(scope).slice(0, 40)) {
    if (definitions.length >= MAX_DEFINITIONS || used >= budget) break;
    const name = identifier.text;
    if (seen.has(name)) continue;
    seen.add(name);

    const defs =
      opts.checker.service.getDefinitionAtPosition(opts.file, identifier.getStart(source)) ?? [];
    for (const def of defs) {
      if (isLibrary(def.fileName)) continue;
      // Context is only sent to the model from inside the workspace. A repo-controlled path mapping
      // must not pull files from outside it.
      if (!isInside(opts.workspace, def.fileName)) continue;
      const defSource = program.getSourceFile(def.fileName);
      if (!defSource) continue;
      if (defSource.fileName === source.fileName && insideRange(def.textSpan.start, scope))
        continue;
      const declaration = declarationAt(defSource, def.textSpan.start);
      const candidate = block(
        defSource,
        declaration,
        relative(opts.workspace, defSource.fileName),
        `definition of ${name}`,
        MAX_DEFINITION_LINES,
      );
      if (used + candidate.text.length > budget) break;
      used += candidate.text.length;
      definitions.push(candidate);
      break;
    }
  }

  return { enclosing, definitions };
}
