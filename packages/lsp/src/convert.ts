import { fileURLToPath } from "node:url";
import * as lsp from "vscode-languageserver-protocol";
import type {
  Diagnostic,
  DiagnosticSeverity,
  Location,
  Position,
  Range,
  ResourceOperation,
  TextEdit,
  WorkspaceEdit,
} from "./types.js";

/** LSP URI to absolute path. Non-file URIs are returned unchanged. */
export function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function fromLspRange(range: lsp.Range): Range {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 },
  };
}

/** 1-based position to the 0-based LSP position. The caller validates the numbers first. */
export function toLspPosition(position: Position): lsp.Position {
  return { line: position.line - 1, character: position.column - 1 };
}

const SEVERITY: Readonly<Record<number, DiagnosticSeverity>> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

export function fromLspDiagnostic(file: string, diagnostic: lsp.Diagnostic): Diagnostic {
  const severity = diagnostic.severity === undefined ? "error" : SEVERITY[diagnostic.severity];
  return {
    file,
    range: fromLspRange(diagnostic.range),
    severity: severity ?? "error",
    ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    message: markupToText(diagnostic.message),
  };
}

/** Diagnostic messages are plain strings in practice; flatten MarkupContent to its value. */
function markupToText(message: string | lsp.MarkupContent): string {
  return typeof message === "string" ? message : message.value;
}

export function fromLspLocations(
  result: lsp.Location | lsp.LocationLink | (lsp.Location | lsp.LocationLink)[] | null,
): Location[] {
  if (result === null) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item): Location => {
    if ("targetUri" in item) {
      return { file: uriToPath(item.targetUri), range: fromLspRange(item.targetSelectionRange) };
    }
    return { file: uriToPath(item.uri), range: fromLspRange(item.range) };
  });
}

function textEdit(edit: lsp.TextEdit): TextEdit {
  return { range: fromLspRange(edit.range), newText: edit.newText };
}

export function fromLspWorkspaceEdit(edit: lsp.WorkspaceEdit | null): WorkspaceEdit {
  const byFile = new Map<string, TextEdit[]>();
  const resourceOperations: ResourceOperation[] = [];

  const addEdits = (
    uri: string,
    edits: readonly (lsp.TextEdit | lsp.AnnotatedTextEdit | lsp.SnippetTextEdit)[],
  ): void => {
    const file = uriToPath(uri);
    const list = byFile.get(file) ?? [];
    for (const item of edits) {
      // Snippet edits carry no plain newText; rename never produces them, so they are skipped.
      if ("newText" in item) list.push(textEdit(item));
    }
    byFile.set(file, list);
  };

  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) addEdits(uri, edits);

  for (const change of edit?.documentChanges ?? []) {
    if (lsp.TextDocumentEdit.is(change)) {
      addEdits(change.textDocument.uri, change.edits);
    } else if (lsp.CreateFile.is(change)) {
      resourceOperations.push({ kind: "create", file: uriToPath(change.uri) });
    } else if (lsp.RenameFile.is(change)) {
      resourceOperations.push({
        kind: "rename",
        file: uriToPath(change.oldUri),
        newFile: uriToPath(change.newUri),
      });
    } else if (lsp.DeleteFile.is(change)) {
      resourceOperations.push({ kind: "delete", file: uriToPath(change.uri) });
    }
  }

  return {
    files: [...byFile.entries()].map(([file, edits]) => ({ file, edits })),
    resourceOperations,
  };
}
