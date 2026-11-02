import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Workspace {
  readonly root: string;
  /** Database path, kept outside the workspace so it is never indexed. */
  readonly dbPath: string;
  readonly cleanup: () => void;
}

/** Creates a temp workspace with the given files (relative path to content). */
export function makeWorkspace(files: Record<string, string>): Workspace {
  const base = mkdtempSync(join(tmpdir(), "fcx-index-"));
  const root = join(base, "project");
  mkdirSync(root);
  for (const [rel, content] of Object.entries(files)) {
    writeFile(root, rel, content);
  }
  return {
    root,
    dbPath: join(base, "index.sqlite"),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export function writeFile(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

export function removeFile(root: string, rel: string): void {
  rmSync(join(root, rel));
}

/** Runs git in `cwd` with a fixed identity. Only used on temp repositories. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-C",
      cwd,
      ...args,
    ],
    { encoding: "utf8" },
  );
}

/** True when `name` runs with `args` and exits 0. Used to skip tests whose toolchain is absent. */
export function hasCommand(name: string, args: readonly string[]): boolean {
  const result = spawnSync(name, [...args], { stdio: "ignore" });
  return result.error === undefined && result.status === 0;
}
