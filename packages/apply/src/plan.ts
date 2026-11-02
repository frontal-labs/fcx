import { sha256 } from "./hash.js";
import { readUtf8 } from "./io.js";
import { resolveInWorkspace } from "./path.js";
import { applyEditsToText } from "./text.js";
import type { Edit, PlannedFile } from "./types.js";

/**
 * Computes the new content of each file. `baseTexts` supplies the text the edits were verified against,
 * keyed by absolute path. A file missing from it is read from disk. Nothing is written here.
 */
export function planEdits(
  workspace: string,
  edits: readonly Edit[],
  baseTexts: ReadonlyMap<string, string> = new Map(),
): PlannedFile[] {
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    const path = resolveInWorkspace(workspace, edit.file);
    byFile.set(path, [...(byFile.get(path) ?? []), edit]);
  }
  return [...byFile].map(([path, fileEdits]) => {
    const original = baseTexts.get(path) ?? readUtf8(path);
    const updated = applyEditsToText(original, fileEdits);
    const after = original.includes("\r\n") ? updated.replace(/\n/g, "\r\n") : updated;
    return { path, before: sha256(original), after, original };
  });
}
