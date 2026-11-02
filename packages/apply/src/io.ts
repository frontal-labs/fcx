import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Writes `text` over `path` through a temp file and a rename, keeping the file's mode. */
export function restoreText(path: string, text: string): void {
  const mode = statSync(path).mode & 0o7777;
  const tmp = join(dirname(path), `.fcx-${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmp, text, "utf-8");
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

export function readUtf8(path: string): string {
  return readFileSync(path, "utf-8");
}
