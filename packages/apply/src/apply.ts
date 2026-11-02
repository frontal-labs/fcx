import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StaleFileError } from "./errors.js";
import { sha256 } from "./hash.js";
import { readUtf8, restoreText, safeUnlink } from "./io.js";
import type { ApplyResult, PlannedFile } from "./types.js";

/**
 * Writes a plan to disk, all or nothing. Every file is re-read and checked against the hash it was
 * verified with. Temp files are staged for every file before any target changes. If a rename fails part
 * way, the files already renamed are restored from their originals. Each file keeps its permission bits.
 * Originals are saved under `undoRoot/<id>` so `undo` can restore them.
 */
export function applyPlan(plan: readonly PlannedFile[], undoRoot: string): ApplyResult {
  for (const file of plan) {
    if (sha256(readUtf8(file.path)) !== file.before) throw new StaleFileError(file.path);
  }

  const undoId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const dir = join(undoRoot, undoId);
  mkdirSync(join(dir, "files"), { recursive: true });
  plan.forEach((file, index) => {
    writeFileSync(join(dir, "files", `${index}.orig`), file.original, "utf-8");
  });

  const staged: string[] = [];
  const renamed: number[] = [];
  try {
    for (const file of plan) {
      const tmp = join(dirname(file.path), `.fcx-${randomUUID().slice(0, 8)}.tmp`);
      writeFileSync(tmp, file.after, "utf-8");
      chmodSync(tmp, statSync(file.path).mode & 0o7777);
      staged.push(tmp);
    }
    plan.forEach((file, index) => {
      renameSync(staged[index] as string, file.path);
      renamed.push(index);
    });
  } catch (error) {
    // Roll back: remove unused temp files, and restore any file already replaced.
    for (const tmp of staged.slice(renamed.length)) safeUnlink(tmp);
    for (const index of renamed) {
      const file = plan[index];
      if (file) restoreText(file.path, file.original);
    }
    throw error;
  }

  const files = plan.map((file) => ({
    path: file.path,
    before: file.before,
    after: sha256(file.after),
  }));
  const manifest = { id: undoId, createdAt: new Date().toISOString(), files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  writeFileSync(join(undoRoot, "LATEST"), undoId, "utf-8");
  return { undoId, files };
}
