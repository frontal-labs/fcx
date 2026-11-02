import type { Diagnostic } from "./types.js";

export function errorsOnly(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((d) => d.category === "error");
}
