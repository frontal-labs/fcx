import type { OutputFormat } from "./args.js";

/** Prints a result either as pretty JSON or as human-readable lines. */
export function emit(format: OutputFormat, value: unknown, text: () => string): void {
  console.log(format === "json" ? JSON.stringify(value, null, 2) : text());
}
