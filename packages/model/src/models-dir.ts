import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root: the nearest folder above this file whose package.json is the workspace root, or undefined. */
function repositoryRoot(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "@fcx/root")
          return dir;
      } catch {
        // An unreadable package.json is not the root; keep looking.
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Where local model files live. `FCX_MODELS_DIR` overrides it. Otherwise it is the `models/` folder of the repository this
 * code runs from (found by walking up from this file, so it works from source and from the bundle). An installed package
 * has no repository, and then the default is `~/.cache/fcx/models`.
 */
export function modelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FCX_MODELS_DIR;
  if (configured !== undefined && configured !== "") return resolve(configured);
  const root = repositoryRoot(dirname(fileURLToPath(import.meta.url)));
  return root !== undefined ? join(root, "models") : join(homedir(), ".cache", "fcx", "models");
}
