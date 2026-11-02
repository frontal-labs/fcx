import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findExecutable } from "../src/exec.js";

export interface TempTree {
  root: string;
  cleanup(): Promise<void>;
}

/** Writes `files` (relative path to text) under a fresh directory in the OS temp dir. */
export async function makeWorkspace(files: Readonly<Record<string, string>>): Promise<TempTree> {
  const root = await mkdtemp(join(tmpdir(), "fcx-verify-test-ws-"));
  for (const [rel, text] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, text, "utf-8");
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export function hasExecutable(name: string): boolean {
  return findExecutable(name) !== undefined;
}

/** True when `python3 -c "import pyflakes"` succeeds. Nothing is installed. */
export function hasPyflakes(): boolean {
  const python = findExecutable("python3");
  if (python === undefined) return false;
  return spawnSync(python, ["-c", "import pyflakes"]).status === 0;
}
