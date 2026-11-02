import ts from "typescript";
import { buildChunk } from "./chunk.js";
import type { SymbolInput, SymbolKind } from "./types.js";

export type ImportBinding =
  | { readonly kind: "named"; readonly local: string; readonly imported: string }
  | { readonly kind: "namespace"; readonly local: string }
  | { readonly kind: "default"; readonly local: string };

export interface ImportRecord {
  readonly specifier: string;
  readonly bindings: readonly ImportBinding[];
}

export type CallReceiver =
  | { readonly kind: "this" }
  | { readonly kind: "identifier"; readonly name: string };

export interface CallRecord {
  /** Index into `symbols` of the enclosing function, method or test. */
  readonly caller: number;
  readonly name: string;
  readonly receiver: CallReceiver | undefined;
}

export interface ExtractionResult {
  readonly symbols: SymbolInput[];
  readonly imports: ImportRecord[];
  readonly calls: CallRecord[];
}

/** Test files as named in plan section 8.2. `.tsx`/`.js` variants are accepted too. */
export function isTestFile(relPath: string): boolean {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relPath);
}

export function languageOf(relPath: string): "ts" | "js" | undefined {
  if (/\.[cm]?tsx?$/.test(relPath)) {
    return "ts";
  }
  if (/\.[cm]?jsx?$/.test(relPath)) {
    return "js";
  }
  return undefined;
}

function scriptKindFor(relPath: string): ts.ScriptKind {
  if (relPath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (relPath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (/\.[cm]?jsx?$/.test(relPath)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

const TEST_GROUPS = new Set(["describe", "context", "suite"]);
const TEST_CASES = new Set(["it", "test", "specify"]);
const MAX_SIGNATURE_LENGTH = 200;
const MAX_DOC_LENGTH = 400;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function isPrivateMember(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  return (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function memberName(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isPrivateIdentifier(name)
  ) {
    return name.text;
  }
  return undefined;
}

function isFunctionLike(
  node: ts.Node | undefined,
): node is ts.ArrowFunction | ts.FunctionExpression {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

function stringArgument(node: ts.Expression | undefined): string | undefined {
  if (
    node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

class Extractor {
  readonly #sf: ts.SourceFile;
  readonly #text: string;
  readonly #lines: string[];
  readonly #isTest: boolean;
  readonly #symbols: SymbolInput[] = [];
  readonly #owners = new Map<ts.Node, number>();
  readonly #imports: ImportRecord[] = [];
  readonly #calls: CallRecord[] = [];

  constructor(relPath: string, text: string) {
    this.#text = text;
    this.#lines = text.split(/\r?\n/);
    this.#sf = ts.createSourceFile(
      relPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(relPath),
    );
    this.#isTest = isTestFile(relPath);
  }

  run(): ExtractionResult {
    for (const statement of this.#sf.statements) {
      this.#visitStatement(statement);
    }
    if (this.#isTest) {
      for (const statement of this.#sf.statements) {
        this.#collectTests(statement, []);
      }
    }
    this.#collectCalls(this.#sf, -1);
    return { symbols: this.#symbols, imports: this.#imports, calls: this.#calls };
  }

  #visitStatement(statement: ts.Statement): void {
    if (ts.isImportDeclaration(statement)) {
      this.#addImport(statement.moduleSpecifier, statement.importClause);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      this.#addImport(statement.moduleSpecifier, undefined);
    } else if (ts.isFunctionDeclaration(statement)) {
      this.#addFunction(statement);
    } else if (ts.isClassDeclaration(statement)) {
      this.#addClass(statement);
    } else if (ts.isInterfaceDeclaration(statement)) {
      this.#addDeclaration(
        statement,
        statement.name.text,
        "interface",
        statement.members.pos,
        hasExportModifier(statement),
      );
    } else if (ts.isEnumDeclaration(statement)) {
      this.#addDeclaration(
        statement,
        statement.name.text,
        "enum",
        statement.members.pos,
        hasExportModifier(statement),
      );
    } else if (ts.isTypeAliasDeclaration(statement)) {
      this.#addDeclaration(
        statement,
        statement.name.text,
        "type",
        statement.end,
        hasExportModifier(statement),
      );
    } else if (ts.isVariableStatement(statement)) {
      this.#addVariables(statement);
    }
  }

  #addImport(specifier: ts.Expression, clause: ts.ImportClause | undefined): void {
    if (!ts.isStringLiteral(specifier)) {
      return;
    }
    const bindings: ImportBinding[] = [];
    if (clause?.name !== undefined) {
      bindings.push({ kind: "default", local: clause.name.text });
    }
    const named = clause?.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) {
      bindings.push({ kind: "namespace", local: named.name.text });
    } else if (named !== undefined && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        bindings.push({
          kind: "named",
          local: element.name.text,
          imported: (element.propertyName ?? element.name).text,
        });
      }
    }
    this.#imports.push({ specifier: specifier.text, bindings });
  }

  #addFunction(node: ts.FunctionDeclaration): void {
    if (node.body === undefined) {
      return;
    }
    const name = node.name?.text ?? "default";
    const index = this.#add({
      name,
      qualified: name,
      kind: "function",
      node,
      headerEnd: node.body.getStart(this.#sf),
      docNode: node,
      exported: hasExportModifier(node),
    });
    this.#owners.set(node, index);
  }

  #addClass(node: ts.ClassDeclaration): void {
    const name = node.name?.text ?? "default";
    const exported = hasExportModifier(node);
    this.#add({
      name,
      qualified: name,
      kind: "class",
      node,
      headerEnd: node.members.pos,
      docNode: node,
      exported,
    });
    for (const member of node.members) {
      this.#addMember(name, member, exported);
    }
  }

  #addMember(className: string, member: ts.ClassElement, classExported: boolean): void {
    let methodName: string | undefined;
    let owner: ts.Node | undefined;
    let headerEnd: number | undefined;
    if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
      methodName = "constructor";
      owner = member;
      headerEnd = member.body.getStart(this.#sf);
    } else if (
      (ts.isMethodDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) ||
        ts.isSetAccessorDeclaration(member)) &&
      member.body !== undefined
    ) {
      methodName = memberName(member.name);
      owner = member;
      headerEnd = member.body.getStart(this.#sf);
    } else if (ts.isPropertyDeclaration(member) && isFunctionLike(member.initializer)) {
      methodName = memberName(member.name);
      owner = member.initializer;
      headerEnd = member.initializer.body.getStart(this.#sf);
    }
    if (methodName === undefined || owner === undefined || headerEnd === undefined) {
      return;
    }
    const index = this.#add({
      name: methodName,
      qualified: `${className}.${methodName}`,
      kind: "method",
      node: member,
      headerEnd,
      docNode: member,
      exported: classExported && !isPrivateMember(member),
    });
    this.#owners.set(owner, index);
  }

  #addDeclaration(
    node: ts.Node,
    name: string,
    kind: SymbolKind,
    headerEnd: number,
    exported: boolean,
  ): void {
    this.#add({ name, qualified: name, kind, node, headerEnd, docNode: node, exported });
  }

  #addVariables(statement: ts.VariableStatement): void {
    const exported = hasExportModifier(statement);
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const keyword = isConst
      ? "const"
      : statement.declarationList.flags & ts.NodeFlags.Let
        ? "let"
        : "var";
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      const name = declaration.name.text;
      const init = declaration.initializer;
      if (isFunctionLike(init)) {
        const index = this.#add({
          name,
          qualified: name,
          kind: "function",
          node: declaration,
          headerEnd: init.body.getStart(this.#sf),
          docNode: statement,
          exported,
          keyword,
        });
        this.#owners.set(init, index);
        continue;
      }
      this.#add({
        name,
        qualified: name,
        kind: isConst ? "const" : "var",
        node: declaration,
        headerEnd: init !== undefined ? init.getStart(this.#sf) : declaration.end,
        docNode: statement,
        exported,
        keyword,
      });
    }
  }

  /** Walks describe/it blocks in a test file. Each test case becomes a `test` symbol. */
  #collectTests(node: ts.Node, groups: readonly string[]): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      const title = stringArgument(node.arguments[0]);
      const body = node.arguments[1];
      if (title !== undefined && isFunctionLike(body)) {
        if (TEST_GROUPS.has(callee)) {
          this.#collectTests(body.body, [...groups, title]);
          return;
        }
        if (TEST_CASES.has(callee)) {
          const qualified = [...groups, title].join(" > ");
          const index = this.#add({
            name: title,
            qualified,
            kind: "test",
            node,
            headerEnd: body.getStart(this.#sf),
            docNode: node,
            exported: false,
            signature: `${callee}(${JSON.stringify(title)})`,
          });
          this.#owners.set(body, index);
          return;
        }
      }
    }
    ts.forEachChild(node, (child) => {
      this.#collectTests(child, groups);
    });
  }

  #collectCalls(node: ts.Node, caller: number): void {
    const owner = this.#owners.get(node);
    const current = owner ?? caller;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      this.#recordCall(node.expression, current);
    }
    ts.forEachChild(node, (child) => {
      this.#collectCalls(child, current);
    });
  }

  #recordCall(expression: ts.Expression, caller: number): void {
    if (caller < 0) {
      return;
    }
    if (ts.isIdentifier(expression)) {
      this.#calls.push({ caller, name: expression.text, receiver: undefined });
      return;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.name)) {
      const target = expression.expression;
      if (target.kind === ts.SyntaxKind.ThisKeyword) {
        this.#calls.push({ caller, name: expression.name.text, receiver: { kind: "this" } });
      } else if (ts.isIdentifier(target)) {
        this.#calls.push({
          caller,
          name: expression.name.text,
          receiver: { kind: "identifier", name: target.text },
        });
      }
    }
  }

  #add(input: {
    name: string;
    qualified: string;
    kind: SymbolKind;
    node: ts.Node;
    headerEnd: number;
    docNode: ts.Node;
    exported: boolean;
    keyword?: string;
    signature?: string;
  }): number {
    const start = input.node.getStart(this.#sf);
    const startLine = this.#sf.getLineAndCharacterOfPosition(start).line + 1;
    const endLine = this.#sf.getLineAndCharacterOfPosition(input.node.end).line + 1;
    let header = collapse(this.#text.slice(start, input.headerEnd))
      .replace(/\s*(\{|=>|=)$/, "")
      .trim();
    if (input.keyword !== undefined && input.kind !== "test") {
      header = `${input.keyword} ${header}`;
    }
    if (input.kind === "type") {
      header = collapse(this.#text.slice(start, input.node.end)).replace(/;$/, "");
    }
    const signature = input.signature ?? header.slice(0, MAX_SIGNATURE_LENGTH);
    const doc = this.#docOf(input.docNode);
    const chunk = buildChunk({
      qualified: input.qualified,
      signature,
      doc,
      lines: this.#lines,
      startLine,
      endLine,
    });
    this.#symbols.push({
      name: input.name,
      qualified: input.qualified,
      kind: input.kind,
      startLine,
      endLine,
      signature,
      doc,
      exported: input.exported,
      chunkText: chunk.text,
      tokens: chunk.tokens,
    });
    return this.#symbols.length - 1;
  }

  #docOf(node: ts.Node): string {
    const ranges = ts.getLeadingCommentRanges(this.#text, node.getFullStart()) ?? [];
    let jsdoc: ts.CommentRange | undefined;
    for (const range of ranges) {
      if (
        range.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        this.#text.startsWith("/**", range.pos)
      ) {
        jsdoc = range;
      }
    }
    if (jsdoc === undefined) {
      return "";
    }
    const body = this.#text.slice(jsdoc.pos + 3, jsdoc.end - 2);
    return body
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*?\s?/, "").trimEnd())
      .join("\n")
      .trim()
      .slice(0, MAX_DOC_LENGTH);
  }
}

/** Extracts symbols, imports and call sites from one TypeScript or JavaScript file. */
export function extractFile(relPath: string, text: string): ExtractionResult {
  return new Extractor(relPath, text).run();
}
