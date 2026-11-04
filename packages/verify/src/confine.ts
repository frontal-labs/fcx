import { dirname, resolve } from "node:path";
import type ts from "typescript";
import { isWithin } from "./paths.js";

/**
 * Removes options that would make the compiler resolve modules or types outside `root`: `paths` targets,
 * `baseUrl`, and `typeRoots`. Those can name any file on disk. Dropping them can cause a false error,
 * which the verify layer then rejects, so the failure is safe.
 */
export function confine(
  options: ts.CompilerOptions,
  configDir: string,
  root: string,
): ts.CompilerOptions {
  const out: ts.CompilerOptions = { ...options };
  const baseDir = out.baseUrl ? resolve(configDir, out.baseUrl) : configDir;
  if (out.baseUrl && !isWithin(root, baseDir)) Reflect.deleteProperty(out, "baseUrl");
  if (out.typeRoots) {
    out.typeRoots = out.typeRoots.filter((dir) => isWithin(root, resolve(configDir, dir)));
  }
  if (out.paths) {
    const kept: Record<string, string[]> = {};
    for (const [pattern, targets] of Object.entries(out.paths)) {
      const inside = targets.filter((t) => isWithin(root, resolve(baseDir, t.replaceAll("*", ""))));
      if (inside.length > 0) kept[pattern] = inside;
    }
    out.paths = kept;
  }
  return out;
}
