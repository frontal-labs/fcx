import type { ContextBlock, FixContext } from "./types.js";

/** Renders context blocks as the text that goes into a prompt. */
export function renderContext(context: FixContext): string {
  const blocks = [context.enclosing, ...context.definitions].filter(
    (b): b is ContextBlock => b !== null,
  );
  return blocks
    .map((b) => `--- ${b.file}:${b.startLine}-${b.endLine} (${b.why})\n${b.text}`)
    .join("\n\n");
}
