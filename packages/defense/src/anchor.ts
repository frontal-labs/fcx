import { type Edit, EditError, applyEditsToText, resolveInWorkspace } from "@fcx/apply";
import type { Bundle, LayerOutcome } from "./types.js";
import { fail, relativeName } from "./util.js";

/**
 * Layer 2: each `search` string matches exactly once, applying edits in order.
 * Returns the new text per file so the verify layer checks exactly what would be written.
 */
export function anchor(
  edits: readonly Edit[],
  bundle: Bundle,
  readFile: (path: string) => string,
): { outcome: LayerOutcome; texts: Map<string, string> } {
  const t0 = performance.now();
  const texts = new Map<string, string>();
  const byFile = new Map<string, Edit[]>();
  for (const edit of edits) {
    const path = resolveInWorkspace(bundle.workspace, edit.file);
    byFile.set(path, [...(byFile.get(path) ?? []), edit]);
  }

  for (const [path, fileEdits] of byFile) {
    try {
      texts.set(path, applyEditsToText(readFile(path), fileEdits));
    } catch (error) {
      const reason = error instanceof EditError ? error.code : "ANCHOR_ERROR";
      const detail =
        error instanceof EditError && error.code === "ANCHOR_NOT_UNIQUE"
          ? "Its search text matches more than once. Make it longer so it matches one place."
          : "Its search text does not match the file exactly. Copy it character for character from the file.";
      const ms = Math.round(performance.now() - t0);
      return {
        texts,
        outcome: fail(
          "anchor",
          reason,
          `Edit for ${relativeName(bundle.workspace, path)} failed. ${detail}`,
          ms,
        ),
      };
    }
  }
  return {
    texts,
    outcome: { layer: "anchor", pass: true, ms: Math.round(performance.now() - t0) },
  };
}
