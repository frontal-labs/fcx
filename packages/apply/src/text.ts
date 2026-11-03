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
    const exact = current.indexOf(search);
    if (exact !== -1) {
      if (current.indexOf(search, exact + 1) !== -1) {
        throw new EditError("ANCHOR_NOT_UNIQUE", "search text occurs more than once in the file");
      }
      current = replaceRange(current, exact, exact + search.length, edit.replace);
      continue;
    }
    // Models often get indentation or trailing spaces slightly wrong. Match whole lines with surrounding
    // whitespace ignored, and only when that identifies exactly one place.
    const loose = locateLoosely(current, search);
    if (loose === "ambiguous") {
      throw new EditError("ANCHOR_NOT_UNIQUE", "search text occurs more than once in the file");
    }
    if (loose === undefined) {
      throw new EditError("ANCHOR_NOT_FOUND", "search text does not occur in the file");
    }
    current = replaceRange(current, loose.start, loose.end, edit.replace);
  }
  return current;
}

function replaceRange(text: string, start: number, end: number, replace: string): string {
  return text.slice(0, start) + replace.replace(/\r\n/g, "\n") + text.slice(end);
}

/**
 * The character range of the one place where the search lines match the file's lines after trimming each line.
 * Leading and trailing blank search lines are ignored. Returns undefined when nothing matches and "ambiguous" when
 * more than one place does.
 */
function locateLoosely(
  text: string,
  search: string,
): { start: number; end: number } | undefined | "ambiguous" {
  const needle = search.split("\n");
  while (needle.length > 0 && needle[0]?.trim() === "") needle.shift();
  while (needle.length > 0 && needle[needle.length - 1]?.trim() === "") needle.pop();
  if (needle.length === 0) return undefined;
  const wanted = needle.map((line) => line.trim());

  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const matches: { start: number; end: number }[] = [];
  for (let i = 0; i + wanted.length <= lines.length; i++) {
    const window = lines.slice(i, i + wanted.length).map((line) => line.trim());
    if (window.every((line, j) => line === wanted[j])) {
      const last = i + wanted.length - 1;
      matches.push({
        start: offsets[i] ?? 0,
        end: (offsets[last] ?? 0) + (lines[last]?.length ?? 0),
      });
      if (matches.length > 1) return "ambiguous";
    }
  }
  return matches[0];
}
