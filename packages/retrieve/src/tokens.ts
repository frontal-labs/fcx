import { CHARS_PER_TOKEN } from "./constants.js";

/** Approximate token count: `ceil(chars / 3.5)`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
