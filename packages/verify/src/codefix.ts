import type ts from "typescript";
import type { Checker, Diagnostic, SearchReplace } from "./types.js";

/**
 * Asks the TypeScript compiler for quick fixes for `diagnostic` and turns the first one into a
 * search/replace block for `text`. The block covers whole lines and grows until its search text is unique.
 * Returns undefined when the compiler offers no fix, or the fix cannot be expressed as one unique block.
 */
export function compilerFix(
  checker: Checker,
  file: string,
  text: string,
  diagnostic: Diagnostic,
): SearchReplace | undefined {
  const program = checker.service.getProgram();
  const source = program?.getSourceFile(file);
  if (!source) return undefined;

  const start = source.getPositionOfLineAndCharacter(diagnostic.line - 1, diagnostic.column - 1);
  let fixes: readonly ts.CodeFixAction[];
  try {
    fixes = checker.service.getCodeFixesAtPosition(
      file,
      start,
      start + 1,
      [diagnostic.code],
      { indentSize: 2, tabSize: 2, convertTabsToSpaces: true, newLineCharacter: "\n" },
      {},
    );
  } catch {
    return undefined;
  }

  for (const fix of fixes) {
    const change = fix.changes.find((c) => c.fileName === file);
    if (!change) continue;
    const edited = applyTextChanges(text, change.textChanges);
    if (edited === text) continue;
    const block = singleBlock(text, edited);
    if (block) return block;
  }
  return undefined;
}

export function applyTextChanges(text: string, changes: readonly ts.TextChange[]): string {
  let out = text;
  for (const c of [...changes].sort((a, b) => b.span.start - a.span.start)) {
    out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
  }
  return out;
}

/** Returns the smallest whole-line block that differs between `before` and `after`, made unique in `before`. */
export function singleBlock(before: string, after: string): SearchReplace | undefined {
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Widen to whole lines.
  let from = before.lastIndexOf("\n", prefix - 1) + 1;
  let to = before.indexOf("\n", before.length - suffix);
  to = to === -1 ? before.length : to;
  for (let attempt = 0; attempt < 20; attempt++) {
    const search = before.slice(from, to);
    if (search.length > 0 && before.indexOf(search) === before.lastIndexOf(search)) {
      // The text after `to` is unchanged, so the replacement ends at the same distance from the end.
      return { search, replace: after.slice(from, after.length - (before.length - to)) };
    }
    if (from === 0 && to === before.length) break;
    // Grow by one line on each side to disambiguate.
    if (from > 0) from = before.lastIndexOf("\n", from - 2) + 1;
    if (to < before.length) {
      const next = before.indexOf("\n", to + 1);
      to = next === -1 ? before.length : next;
    }
  }
  return undefined;
}
