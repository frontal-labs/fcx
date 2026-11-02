/** Body lines included in a symbol's chunk text (plan section 8.2, "first N lines"). */
export const CHUNK_BODY_LINES = 24;

/** Token cap for a chunk, as in plan section 8.2. Tokens are whitespace-separated words. */
export const CHUNK_MAX_TOKENS = 256;

export interface ChunkSource {
  readonly qualified: string;
  readonly signature: string;
  readonly doc: string;
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Chunk text = qualified name, signature, doc and the first lines of the body, capped at
 * `CHUNK_MAX_TOKENS` whitespace-separated tokens. The token count is an approximation.
 */
export function buildChunk(source: ChunkSource): { text: string; tokens: number } {
  const first = source.startLine - 1;
  const last = Math.min(source.endLine, first + CHUNK_BODY_LINES);
  const body = source.lines.slice(first, last).join("\n");
  const joined = [source.qualified, source.signature, source.doc, body]
    .filter((part) => part.length > 0)
    .join("\n");
  const words = joined.split(/\s+/).filter((word) => word.length > 0);
  if (words.length <= CHUNK_MAX_TOKENS) {
    return { text: joined, tokens: words.length };
  }
  return { text: words.slice(0, CHUNK_MAX_TOKENS).join(" "), tokens: CHUNK_MAX_TOKENS };
}
