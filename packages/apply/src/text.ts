import { EditError } from "./errors.js";
import type { Edit } from "./types.js";

/**
 * Applies search/replace edits in order to `text`, normalizing CRLF to LF for matching.
 * Each search must match exactly once at the moment it is applied.
 */
export function applyEditsToText(
  text: string,
  edits: readonly Pick<Edit, "search" | "replace">[],
): string {
  let current = text.replace(/\r\n/g, "\n");
  for (const edit of edits) {
    const search = edit.search.replace(/\r\n/g, "\n");
    if (search.length === 0) {
      throw new EditError("EMPTY_SEARCH", "search text is empty");
    }
    const first = current.indexOf(search);
    if (first === -1) {
      throw new EditError("ANCHOR_NOT_FOUND", "search text does not occur in the file");
    }
    if (current.indexOf(search, first + 1) !== -1) {
      throw new EditError("ANCHOR_NOT_UNIQUE", "search text occurs more than once in the file");
    }
    current =
      current.slice(0, first) +
      edit.replace.replace(/\r\n/g, "\n") +
      current.slice(first + search.length);
  }
  return current;
}
