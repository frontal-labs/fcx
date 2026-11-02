import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ContextBlock, ContextBundle, FixContext } from "@fcx/retrieve";
import type { Checker } from "@fcx/verify";
import ts from "typescript";

/** A definition location returned by a language server. Line and column are 1-based. */
export interface DefinitionLocation {
  /** Absolute path. */
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Asks a language server where the symbol at a position is defined. Line and column are 1-based. Rejects on any
 * server error or timeout; the caller falls back to the checker's definitions.
 */
export type DefinitionsAt = (
  file: string,
  line: number,
  column: number,
) => Promise<readonly DefinitionLocation[]>;

/** Where the definition context came from. `lsp` means the server answered at least one query. */
export interface ContextReport {
  readonly source: "lsp" | "checker";
  readonly notes: string[];
}

/** Mirrors packages/retrieve/src/constants.ts, which does not export them. */
const DEFAULT_BUDGET_CHARS = 9000;
const MAX_DEFINITION_LINES = 6;
const MAX_DEFINITIONS = 8;
const MAX_IDENTIFIERS = 40;
const DEFINITION_PREFIX = "definition of ";

export interface LspDefinitionsInput {
  readonly checker: Checker;
  readonly workspace: string;
  /** Absolute path of the file that has the diagnostic. */
  readonly file: string;
  /** 1-based position of the diagnostic. */
  readonly line: number;
  readonly column: number;
  readonly budgetChars?: number;
  /** The checker's context. Language server definitions are added after it, within the same budget. */
  readonly context: FixContext;
  /** Undefined means no language server: the checker's context is returned unchanged. */
  readonly definitionsAt?: DefinitionsAt;
}

export interface LspDefinitionsResult {
  readonly context: FixContext;
  readonly report: ContextReport;
}

/**
 * The definition step of the context gathering, with a language server. For each identifier in the target's
 * enclosing scope, asks the server for its definition, and adds a block for names the checker did not cover.
 * The block format and budget are those of gatherFixContext. Locations outside the workspace, and inside
 * node_modules, are dropped. The first server error stops the queries; the checker's definitions remain.
 * The server only supplies context: it never decides whether an edit is accepted.
 */
export async function addLspDefinitions(input: LspDefinitionsInput): Promise<LspDefinitionsResult> {
  const checkerOnly = (notes: string[]): LspDefinitionsResult => ({
    context: input.context,
    report: { source: "checker", notes },
  });
  if (input.definitionsAt === undefined) return checkerOnly([]);

  const program = input.checker.service.getProgram();
  const source = program?.getSourceFile(input.file);
  const enclosing = input.context.enclosing;
  if (!program || !source || !enclosing) {
    return checkerOnly(["no program for the file; language server definitions skipped"]);
  }

  const budget = input.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const start = source.getPositionOfLineAndCharacter(
    Math.max(0, input.line - 1),
    Math.max(0, input.column - 1),
  );
  const scope = enclosingScope(tokenAt(source, start) ?? source, source);
  const covered = new Set<string>();
  for (const d of input.context.definitions) {
    if (d.why.startsWith(DEFINITION_PREFIX)) covered.add(d.why.slice(DEFINITION_PREFIX.length));
  }

  const definitions = [...input.context.definitions];
  let used = enclosing.text.length + definitions.reduce((total, d) => total + d.text.length, 0);
  const notes: string[] = [];
  const queried = new Set<string>();
  let answered = false;
  let outside = 0;

  for (const identifier of identifiersIn(scope).slice(0, MAX_IDENTIFIERS)) {
    if (definitions.length >= MAX_DEFINITIONS || used >= budget) break;
    const name = identifier.text;
    if (queried.has(name)) continue;
    queried.add(name);

    const at = source.getLineAndCharacterOfPosition(identifier.getStart(source));
    let locations: readonly DefinitionLocation[];
    try {
      locations = await input.definitionsAt(input.file, at.line + 1, at.character + 1);
    } catch (error) {
      notes.push(
        `language server definition of ${name} failed${failureCode(error)}: ${messageOf(error)}; using checker definitions`,
      );
      break;
    }
    answered = true;
    if (covered.has(name)) continue;

    for (const location of locations) {
      if (!insideWorkspace(input.workspace, location.file)) {
        outside++;
        continue;
      }
      if (/[\\/]node_modules[\\/]/.test(location.file)) continue;
      const defSource = program.getSourceFile(location.file);
      if (!defSource) continue;
      let offset: number;
      try {
        offset = defSource.getPositionOfLineAndCharacter(location.line - 1, location.column - 1);
      } catch {
        continue;
      }
      // Same rule as gatherFixContext: a definition inside the target's own scope is already in the enclosing block.
      if (
        defSource.fileName === source.fileName &&
        offset >= scope.getStart(source) &&
        offset < scope.end
      ) {
        continue;
      }
      const block = declarationBlock(
        defSource,
        declarationAt(defSource, offset),
        relative(input.workspace, defSource.fileName).split(sep).join("/"),
        `${DEFINITION_PREFIX}${name}`,
      );
      if (used + block.text.length > budget) break;
      used += block.text.length;
      definitions.push(block);
      break;
    }
  }

  if (outside > 0) notes.push(`dropped ${outside} definition(s) outside the workspace`);
  return {
    context: { enclosing: input.context.enclosing, definitions },
    report: { source: answered ? "lsp" : "checker", notes },
  };
}

function insideWorkspace(workspace: string, file: string): boolean {
  const rel = relative(resolve(workspace), resolve(file));
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

function failureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return ` (${error.code})`;
  }
  return "";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tokenAt(source: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (pos < node.getStart(source) || pos >= node.end) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

function enclosingScope(start: ts.Node, source: ts.SourceFile): ts.Node {
  let node: ts.Node | undefined = start;
  while (node && node !== source) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return node;
    node = node.parent;
  }
  let statement: ts.Node = start;
  while (statement.parent && statement.parent !== source) statement = statement.parent;
  return statement;
}

function identifiersIn(node: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) out.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return out;
}

function declarationAt(source: ts.SourceFile, pos: number): ts.Node {
  let node: ts.Node = tokenAt(source, pos) ?? source;
  while (node.parent && node.parent !== source && !isDeclarationLike(node)) node = node.parent;
  return node;
}

function isDeclarationLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  );
}

function declarationBlock(
  source: ts.SourceFile,
  node: ts.Node,
  file: string,
  why: string,
): ContextBlock {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(node.end).line;
  const lines = source.text.slice(node.getStart(source), node.end).split("\n");
  const truncated =
    lines.length > MAX_DEFINITION_LINES
      ? `\n// ... ${lines.length - MAX_DEFINITION_LINES} more lines`
      : "";
  return {
    file,
    startLine: start + 1,
    endLine: end + 1,
    text: lines.slice(0, MAX_DEFINITION_LINES).join("\n") + truncated,
    why,
  };
}

/** Thrown when the caller's input cannot be resolved to code, for example a test name that does not exist. */
export class RecipeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeInputError";
  }
}

/** Workspace-relative POSIX path, or the input unchanged when it is outside the workspace. */
export function relativeTo(workspace: string, file: string): string {
  const rel = relative(resolve(workspace), resolve(workspace, file)).split(sep).join("/");
  return rel.startsWith("..") ? file : rel;
}

/** Absolute path for a workspace-relative or absolute file. */
export function absoluteIn(workspace: string, file: string): string {
  return isAbsolute(file) ? resolve(file) : resolve(workspace, file);
}

/** Renders context blocks for a prompt, one labelled block after another. */
export function renderBlocks(blocks: readonly ContextBlock[]): string {
  if (blocks.length === 0) return "(none)";
  return blocks
    .map((b) => `// ${b.file}:${b.startLine}-${b.endLine} (${b.why})\n${b.text}`)
    .join("\n\n");
}

/** Numbers lines `from..to` (1-based, inclusive) of `text`. */
export function numberedRange(text: string, from: number, to: number): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let n = Math.max(1, from); n <= Math.min(lines.length, to); n++) {
    out.push(`${String(n).padStart(4)}| ${lines[n - 1] ?? ""}`);
  }
  return out.join("\n");
}

/** The 1-based line of the first line of `text` that matches `pattern`, or undefined. */
export function findLine(text: string, pattern: RegExp): number | undefined {
  const index = text.split("\n").findIndex((line) => pattern.test(line));
  return index === -1 ? undefined : index + 1;
}

/** Index of the brace that closes the first `{` at or after `from`, or -1 when the braces never balance. */
export function matchingBrace(text: string, from: number): number {
  const open = text.indexOf("{", from);
  if (open === -1) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The text of lines `first..last` (1-based, inclusive). */
export function linesOf(text: string, first: number, last: number): string {
  return text
    .split("\n")
    .slice(first - 1, last)
    .join("\n");
}

/** The retrieval block for the target symbol, if retrieval found one. */
export function targetBlock(bundle: ContextBundle): ContextBlock | undefined {
  return bundle.blocks.find((b) => b.why === "target symbol");
}

/** Character offset where 1-based `line` starts. */
export function lineOffset(text: string, line: number): number {
  let offset = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return offset;
}

/** 1-based line that contains character `offset`. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

/** The first `max` lines of `text`, with a marker when lines were cut. */
export function trimLines(text: string, max: number): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n... (${lines.length - max} more lines)`;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `path` is an existing regular file. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** The text of an existing file. Throws RecipeInputError when it is missing. */
export function readText(path: string): string {
  if (!existsSync(path)) throw new RecipeInputError(`no such file: ${path}`);
  return readFileSync(path, "utf-8");
}
