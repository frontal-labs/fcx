import type { RetrieveTask } from "./types.js";

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Distinct identifiers in `text`, in order of first appearance. */
export function identifiersIn(text: string): string[] {
  const seen = new Set<string>();
  const found: string[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    const identifier = match[0];
    if (!seen.has(identifier)) {
      seen.add(identifier);
      found.push(identifier);
    }
  }
  return found;
}

/**
 * The retrieval query (plan section 8.3): identifiers from the error text and the selection,
 * followed by the user's natural-language text. The index tokenizer splits it further.
 */
export function buildQueryText(task: RetrieveTask): string {
  const code = [task.errorText, task.selection]
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return [...identifiersIn(code), task.text ?? ""]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}
