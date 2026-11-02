/**
 * Parsers for the target syntaxes the recipe commands take. Each returns the parsed value, or a string with the
 * usage problem. Paths are not resolved here; the recipes resolve and confine them to the workspace.
 */

export interface FileSymbolTarget {
  file: string;
  symbol?: string;
}

export interface FileLineTarget {
  file: string;
  line: number;
}

export interface FileRangeTarget {
  file: string;
  startLine: number;
  endLine: number;
}

export interface FileLineColumnTarget {
  file: string;
  line: number;
  column: number;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** `file` or `file:symbol`. The symbol is optional. */
export function parseFileSymbol(target: string): FileSymbolTarget | string {
  const match = /^(.+):([^:]+)$/.exec(target);
  if (match?.[1] !== undefined && match[2] !== undefined && IDENTIFIER.test(match[2])) {
    return { file: match[1], symbol: match[2] };
  }
  if (target === "") return "expected a file, for example src/app.ts";
  return { file: target };
}

/** `file:symbol`. The symbol is required. */
export function parseFileSymbolRequired(target: string): FileSymbolTarget | string {
  const parsed = parseFileSymbol(target);
  if (typeof parsed === "string") return parsed;
  if (parsed.symbol === undefined) return "expected file:symbol, for example src/app.ts:total";
  return { file: parsed.file, symbol: parsed.symbol };
}

/** `file:line`, 1-based. */
export function parseFileLine(target: string): FileLineTarget | string {
  const match = /^(.+):(\d+)$/.exec(target);
  if (!match?.[1] || match[2] === undefined) return "expected file:line, for example src/app.ts:12";
  const line = Number.parseInt(match[2], 10);
  if (line < 1) return "line numbers start at 1";
  return { file: match[1], line };
}

/** `file:start-end` or `file:line`, 1-based and inclusive. */
export function parseFileRange(target: string): FileRangeTarget | string {
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(target);
  if (!match?.[1] || match[2] === undefined) {
    return "expected file:start-end, for example src/app.ts:10-20";
  }
  const startLine = Number.parseInt(match[2], 10);
  const endLine = match[3] === undefined ? startLine : Number.parseInt(match[3], 10);
  if (startLine < 1 || endLine < startLine)
    return `invalid line range ${match[2]}-${match[3] ?? match[2]}`;
  return { file: match[1], startLine, endLine };
}

/** `file:line:column`, both 1-based. */
export function parseFileLineColumn(target: string): FileLineColumnTarget | string {
  const match = /^(.+):(\d+):(\d+)$/.exec(target);
  if (!match?.[1] || match[2] === undefined || match[3] === undefined) {
    return "expected file:line:column, for example src/app.ts:12:7";
  }
  const line = Number.parseInt(match[2], 10);
  const column = Number.parseInt(match[3], 10);
  if (line < 1 || column < 1) return "line and column numbers start at 1";
  return { file: match[1], line, column };
}
