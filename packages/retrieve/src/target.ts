import { isAbsolute, relative, sep } from "node:path";
import type { IndexStore, SymbolRecord } from "@fcx/index";
import { compareText } from "./order.js";
import type { RetrieveTask } from "./types.js";

/** Workspace-relative POSIX path for `file`, which may be absolute or already relative. */
export function workspaceRelative(workspace: string, file: string): string {
  const rel = isAbsolute(file) ? relative(workspace, file) : file;
  return rel.split(sep).join("/").replace(/^\.\//, "");
}

/**
 * Finds the target symbol. With `file` and `line`, the innermost symbol containing the line wins
 * (smallest span, then earliest start, then lowest id). Otherwise `symbol` is matched by name or
 * qualified name, preferring the task's file, then path and line.
 */
export function resolveTarget(
  store: IndexStore,
  task: RetrieveTask,
  workspace: string,
): SymbolRecord | undefined {
  const rel = task.file === undefined ? undefined : workspaceRelative(workspace, task.file);
  if (rel !== undefined && task.line !== undefined) {
    const file = store.fileByPath(rel);
    if (file !== undefined) {
      const line = task.line;
      const containing = store
        .symbolsInFile(file.id)
        .filter((symbol) => symbol.kind !== "module")
        .filter((symbol) => symbol.startLine <= line && line <= symbol.endLine);
      containing.sort(
        (a, b) =>
          a.endLine - a.startLine - (b.endLine - b.startLine) ||
          a.startLine - b.startLine ||
          a.id - b.id,
      );
      const innermost = containing[0];
      if (innermost !== undefined) {
        return innermost;
      }
    }
  }

  const name = task.symbol;
  if (name === undefined || name.length === 0) {
    return undefined;
  }
  const matches: { path: string; symbol: SymbolRecord }[] = [];
  for (const file of store.listFiles()) {
    for (const symbol of store.symbolsInFile(file.id)) {
      if (symbol.name === name || symbol.qualified === name) {
        matches.push({ path: file.path, symbol });
      }
    }
  }
  matches.sort(
    (a, b) =>
      Number(a.path !== rel) - Number(b.path !== rel) ||
      compareText(a.path, b.path) ||
      a.symbol.startLine - b.symbol.startLine ||
      a.symbol.id - b.symbol.id,
  );
  return matches[0]?.symbol;
}
