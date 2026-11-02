import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Finds the nearest tsconfig.json above `file`, stopping at `root`.
 * The project is only read, never executed.
 */
export function findTsconfig(root: string, file: string): string | undefined {
  const boundary = resolve(root);
  for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
    const candidate = join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dir === boundary || dirname(dir) === dir) return undefined;
  }
}

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
