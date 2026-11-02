import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseJsonSafely } from "./json.js";
import type { Env } from "./keys.js";
import type { ConfigWarning, ProjectConfig } from "./types.js";
import { errorMessage, isPlainObject } from "./util.js";

/** First existing `project.json` wins, matching `ProjectConfig::get_config_path`. */
export function findProjectConfig(
  workspace: string,
  env: Env,
  warnings: ConfigWarning[],
  trusted: boolean,
): ProjectConfig {
  const candidates: string[] = [];
  if (env.FRONTAL_CODE_CONFIG_HOME) {
    candidates.push(join(env.FRONTAL_CODE_CONFIG_HOME, "project.json"));
  }
  if (env.FRONTAL_CODE_HOME) {
    candidates.push(join(env.FRONTAL_CODE_HOME, "project.json"));
  }
  candidates.push(join(env.HOME, ".frontal-code", "project.json"));

  let found = candidates.find((path) => existsSync(path));
  if (!found && trusted) {
    // Fallback: a repository that contains both Cargo.toml and config/project.json. It is repo-controlled,
    // so it is only read in a trusted workspace (it can set cache and log directories).
    for (let dir = workspace; ; dir = dirname(dir)) {
      const candidate = join(dir, "config", "project.json");
      if (existsSync(join(dir, "Cargo.toml")) && existsSync(candidate)) {
        found = candidate;
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  if (!found) return {};

  try {
    const value: unknown = parseJsonSafely(readFileSync(found, "utf-8"));
    if (isPlainObject(value)) return value as ProjectConfig;
    throw new Error("expected a JSON object");
  } catch (error) {
    // Frontal Code falls back to defaults here, and so does fcx.
    warnings.push({
      key: "project.json",
      source: found,
      reason: `unreadable, defaults used: ${errorMessage(error)}`,
    });
    return {};
  }
}
