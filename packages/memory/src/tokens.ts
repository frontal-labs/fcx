/**
 * Approximate token count: ceil(characters / 3.5). This is a heuristic, not a tokenizer.
 * Characters are UTF-16 code units (`String.length`).
 */
export function approximateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / 3.5);
}
