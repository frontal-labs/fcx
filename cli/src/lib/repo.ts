import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

/** Stable key for a workspace, used for per-repo cache directories (plan §5.5). */
export function repoKey(workspace: string): string {
  let canonical = resolve(workspace);
  try {
    canonical = realpathSync(canonical);
  } catch {
    // Keep the resolved path when the directory cannot be canonicalized.
  }
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Undo history for one workspace. */
export function undoRootFor(cacheDir: string, workspace: string): string {
  return join(cacheDir, "undo", repoKey(workspace));
}

/** Local memory database for one workspace (plan §12.1). */
export function memoryPathFor(cacheDir: string, workspace: string): string {
  return join(cacheDir, "memory", `${repoKey(workspace)}.sqlite`);
}

/** Code index database for one workspace (plan §5.5). */
export function indexPathFor(cacheDir: string, workspace: string): string {
  return join(cacheDir, "index", `${repoKey(workspace)}.sqlite`);
}
