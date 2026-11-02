/** Maximum number of query terms sent to FTS5. Longer queries are truncated. */
const MAX_TERMS = 64;

/**
 * Turns free text into an FTS5 MATCH expression. Terms are split the way the `unicode61`
 * tokenizer splits them, quoted (so FTS operators in the input are inert), and joined with OR.
 * camelCase and snake_case identifiers also contribute their parts, so `parseConfig` matches
 * text that says "parse config".
 */
export function buildFtsQuery(query: string): string | undefined {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (term: string): void => {
    const lower = term.toLowerCase();
    if (lower.length > 0 && !seen.has(lower)) {
      seen.add(lower);
      terms.push(lower);
    }
  };
  for (const raw of query.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length === 0) {
      continue;
    }
    add(raw);
    for (const part of raw.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)) {
      add(part);
    }
  }
  const limited = terms.slice(0, MAX_TERMS);
  if (limited.length === 0) {
    return undefined;
  }
  return limited.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** Cosine similarity of two equal-length vectors. Returns 0 when either has zero norm. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
