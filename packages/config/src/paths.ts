import { join } from "node:path";
import type { Env } from "./keys.js";
import type { ProjectConfig } from "./types.js";

export function resolvePaths(
  projectConfig: ProjectConfig,
  configHome: string,
  env: Env,
): { cacheDir: string; logsDir: string } {
  const override = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  return {
    cacheDir: expandHome(
      env.FRONTAL_CODE_CACHE_DIR ??
        override(projectConfig.paths?.cache_dir) ??
        join(configHome, "cache"),
      env.HOME,
    ),
    logsDir: expandHome(
      env.FRONTAL_CODE_LOGS_DIR ??
        override(projectConfig.paths?.logs_dir) ??
        join(configHome, "logs"),
      env.HOME,
    ),
  };
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}
