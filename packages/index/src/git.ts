import { execFile } from "node:child_process";

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** Maximum commits read for co-change analysis, as in plan section 8.2. */
export const COCHANGE_COMMIT_LIMIT = 1000;

/** Commits touching more files than this are ignored for co-change (bulk renames, formatting). */
export const COCHANGE_MAX_FILES_PER_COMMIT = 50;

/** Minimum number of shared commits for a file pair to become an edge. */
export const COCHANGE_MIN_COUNT = 3;

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

/** Absolute path of the repository top level, or undefined when `cwd` is not in a repository. */
export async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const out = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const trimmed = out?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * File lists per commit from `git log --name-only -n 1000 --no-merges`. Paths are relative to
 * the repository top level. Returns undefined when git is unavailable.
 */
export async function gitCommitFileSets(cwd: string): Promise<string[][] | undefined> {
  const out = await runGit(cwd, [
    "log",
    "--name-only",
    "-n",
    String(COCHANGE_COMMIT_LIMIT),
    "--no-merges",
    "--pretty=format:%H",
  ]);
  if (out === undefined) {
    return undefined;
  }
  const commits: string[][] = [];
  let current: string[] | undefined;
  for (const line of out.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      continue;
    }
    if (SHA_PATTERN.test(trimmed)) {
      current = [];
      commits.push(current);
    } else if (current !== undefined) {
      current.push(trimmed);
    }
  }
  return commits;
}

export interface CoChangePair {
  readonly a: string;
  readonly b: string;
  readonly count: number;
  /** count / min(changes of a, changes of b). */
  readonly weight: number;
}

/**
 * Counts how often file pairs change in the same commit. Only files in `known` count. Pairs
 * with fewer than `minCount` shared commits are dropped. Pairs are returned with a < b.
 */
export function coChangePairs(
  commits: readonly (readonly string[])[],
  known: ReadonlySet<string>,
  minCount: number = COCHANGE_MIN_COUNT,
  maxFilesPerCommit: number = COCHANGE_MAX_FILES_PER_COMMIT,
): CoChangePair[] {
  const changes = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  for (const commit of commits) {
    const files = [...new Set(commit.filter((path) => known.has(path)))].sort();
    for (const file of files) {
      changes.set(file, (changes.get(file) ?? 0) + 1);
    }
    if (files.length < 2 || files.length > maxFilesPerCommit) {
      continue;
    }
    for (let i = 0; i < files.length; i += 1) {
      for (let j = i + 1; j < files.length; j += 1) {
        const key = `${files[i] ?? ""}\u0000${files[j] ?? ""}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: CoChangePair[] = [];
  for (const [key, count] of pairCounts) {
    if (count < minCount) {
      continue;
    }
    const [a = "", b = ""] = key.split("\u0000");
    const smaller = Math.min(changes.get(a) ?? count, changes.get(b) ?? count);
    pairs.push({ a, b, count, weight: count / smaller });
  }
  pairs.sort((x, y) => (x.a === y.a ? (x.b < y.b ? -1 : x.b > y.b ? 1 : 0) : x.a < y.a ? -1 : 1));
  return pairs;
}
