import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Normalizes a model-supplied path to an absolute path inside `workspace`. Throws for lexical escapes,
 * for symbolic links, and for anything whose real location lies outside the workspace.
 */
export function resolveInWorkspace(workspace: string, file: string): string {
  const root = resolve(workspace);
  const target = resolve(isAbsolute(file) ? file : join(root, file));
  if (!isInside(root, target)) {
    throw new Error(`path escapes the workspace: ${file}`);
  }
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) {
      throw new Error(`refusing to edit a symbolic link: ${file}`);
    }
    if (!isInside(realpathSync(root), realpathSync(target))) {
      throw new Error(`path resolves outside the workspace: ${file}`);
    }
  }
  return target;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
