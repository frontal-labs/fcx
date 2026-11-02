import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256 } from "./hash.js";
import { readUtf8, restoreText } from "./io.js";
import { isInside } from "./path.js";
import type { UndoResult } from "./types.js";

/**
 * Restores the most recent applied change. It refuses if any file has changed since fcx wrote it,
 * or if a recorded path is no longer inside the workspace, so a user's later edit is never reverted.
 */
export function undoLatest(undoRoot: string, workspace: string): UndoResult {
  const latestPath = join(undoRoot, "LATEST");
  const undoId = existsSync(latestPath) ? readFileSync(latestPath, "utf-8").trim() : "";
  if (undoId === "") {
    throw new Error("nothing to undo");
  }
  const dir = join(undoRoot, undoId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as {
    files: Array<{ path: string; after: string }>;
  };

  for (const file of manifest.files) {
    if (!isInside(resolve(workspace), resolve(file.path))) {
      throw new Error(`cannot undo: ${file.path} is outside the workspace`);
    }
  }
  const conflicts = manifest.files.filter(
    (f) => !existsSync(f.path) || sha256(readUtf8(f.path)) !== f.after,
  );
  if (conflicts.length > 0) {
    throw new Error(
      `cannot undo: changed since fcx applied it: ${conflicts.map((c) => c.path).join(", ")}`,
    );
  }

  const restored: string[] = [];
  manifest.files.forEach((file, index) => {
    restoreText(file.path, readFileSync(join(dir, "files", `${index}.orig`), "utf-8"));
    restored.push(file.path);
  });
  writeFileSync(latestPath, "", "utf-8");
  return { undoId, restored };
}
