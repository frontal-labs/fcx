import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { type IgnoreRule, compileIgnoreRules, isPathIgnored } from "./ignore.js";

/** Directory names never walked when the directory is not a git repository. */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "target",
]);

export interface DiscoveredFile {
  /** Workspace-relative POSIX path. */
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DiscoverResult {
  readonly files: DiscoveredFile[];
  /** True when `git ls-files` produced the list. */
  readonly usedGit: boolean;
}

function runGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", "-C", cwd, ...args],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      },
    );
  });
}

async function listWithGit(root: string): Promise<string[] | undefined> {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside === undefined || inside.trim() !== "true") {
    return undefined;
  }
  const listing = await runGit(root, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  if (listing === undefined) {
    return undefined;
  }
  return listing.split("\0").filter((entry) => entry.length > 0);
}

async function readRootIgnore(root: string): Promise<string[]> {
  try {
    return (await readFile(join(root, ".gitignore"), "utf8")).split("\n");
  } catch {
    return [];
  }
}

/**
 * Lists the workspace's files. Inside a git repository the list is `git ls-files` (tracked plus
 * untracked, minus ignored), so `.gitignore` is applied by git. Elsewhere the directory is
 * walked, skipping node_modules, .git, dist and target, and the root `.gitignore` is applied.
 * `exclude` globs (for example `**\/node_modules\/**`) are applied in both modes.
 */
export async function discoverFiles(
  root: string,
  exclude: readonly string[],
): Promise<DiscoverResult> {
  const excludeRules: IgnoreRule[] = compileIgnoreRules(exclude);
  const gitList = await listWithGit(root);
  const candidates: { path: string; isDir: boolean }[] = [];
  let usedGit = false;
  if (gitList !== undefined) {
    usedGit = true;
    for (const path of gitList) {
      candidates.push({ path, isDir: false });
    }
  } else {
    const rules = [...compileIgnoreRules(await readRootIgnore(root)), ...excludeRules];
    await walk(root, "", rules, candidates);
  }

  const files: DiscoveredFile[] = [];
  for (const candidate of candidates) {
    if (isPathIgnored(candidate.path, false, excludeRules)) {
      continue;
    }
    const absolutePath = join(root, candidate.path);
    const info = await lstat(absolutePath).catch(() => undefined);
    if (info === undefined || !info.isFile()) {
      continue;
    }
    files.push({ path: candidate.path, absolutePath, size: info.size, mtimeMs: info.mtimeMs });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, usedGit };
}

async function walk(
  root: string,
  prefix: string,
  rules: readonly IgnoreRule[],
  out: { path: string; isDir: boolean }[],
): Promise<void> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || isPathIgnored(rel, true, rules)) {
        continue;
      }
      await walk(root, rel, rules, out);
    } else if (entry.isFile()) {
      if (!isPathIgnored(rel, false, rules)) {
        out.push({ path: rel, isDir: false });
      }
    }
  }
}
