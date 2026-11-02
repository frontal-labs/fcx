import ts from "typescript";
import type { ContextBlock } from "./types.js";

export function tokenAt(source: ts.SourceFile, pos: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (pos < node.getStart(source) || pos >= node.end) return;
    found = node;
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

export function enclosingScope(start: ts.Node, source: ts.SourceFile): ts.Node {
  let node: ts.Node | undefined = start;
  while (node && node !== source) {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return node;
    node = node.parent;
  }
  // No function or class: use the top-level statement that contains the position.
  let statement: ts.Node = start;
  while (statement.parent && statement.parent !== source) statement = statement.parent;
  return statement;
}

export function identifiersIn(node: ts.Node): ts.Identifier[] {
  const out: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) out.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return out;
}

export function declarationAt(source: ts.SourceFile, pos: number): ts.Node {
  const token = tokenAt(source, pos) ?? source;
  let node: ts.Node = token;
  while (node.parent && node.parent !== source && !isDeclarationLike(node)) node = node.parent;
  return node;
}

export function isDeclarationLike(node: ts.Node): boolean {
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

export function block(
  source: ts.SourceFile,
  node: ts.Node,
  file: string,
  why: string,
  maxLines: number,
): ContextBlock {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const end = source.getLineAndCharacterOfPosition(node.end).line;
  const lines = source.text.slice(node.getStart(source), node.end).split("\n");
  const shown = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines ? `\n// ... ${lines.length - maxLines} more lines` : "";
  return {
    file,
    startLine: start + 1,
    endLine: end + 1,
    text: shown.join("\n") + truncated,
    why,
  };
}

export function insideRange(pos: number, node: ts.Node): boolean {
  return pos >= node.getStart() && pos < node.end;
}
