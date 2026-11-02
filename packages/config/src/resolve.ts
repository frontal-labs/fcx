import { join, resolve } from "node:path";
import { extractFcSettings } from "./fc-settings.js";
import type { Env } from "./keys.js";
import { readEnv } from "./keys.js";
import { resolvePaths } from "./paths.js";
import { resolvePermissionMode } from "./permissions.js";
import { intersectPolicy } from "./policy.js";
import { findProjectConfig } from "./project.js";
import { loadSettings } from "./settings.js";
import { checkTrust } from "./trust.js";
import type { ConfigWarning, ResolveOptions, ResolvedConfig } from "./types.js";
import { canonicalPath } from "./util.js";

/**
 * Resolves the effective configuration the way the Frontal Code runtime does
 * (`crates/code-core/src/config.rs`, `crates/code-runtime/src/config.rs`):
 * - the workspace is the canonical `cwd`, with no parent-directory walk;
 * - project and local settings are read only from that workspace;
 * - an untrusted workspace has its workspace-controlled keys withheld;
 * - the effective permission mode is the lowest one any settings source sets.
 */
export function resolveConfig(
  cwd: string = process.cwd(),
  options: ResolveOptions = {},
  env: Env = readEnv(),
): ResolvedConfig {
  const warnings: ConfigWarning[] = [];
  const configHome = env.FRONTAL_CODE_CONFIG_HOME ?? join(env.HOME, ".frontal-code");
  // Paths are reported as given (like Frontal Code); only trust matching canonicalizes.
  const workspace = resolve(cwd);

  const trust = checkTrust(configHome, canonicalPath(workspace));
  const projectConfig = findProjectConfig(workspace, env, warnings, trust.trusted);
  const loaded = loadSettings(configHome, workspace, trust.trusted, warnings);
  const policy = intersectPolicy(loaded.policies, warnings);
  const permissionMode = resolvePermissionMode(
    loaded.modes,
    projectConfig,
    policy,
    warnings,
    options.permissionMode,
  );
  const local = extractFcSettings(loaded.settings, env);
  const paths = resolvePaths(projectConfig, configHome, env);

  return {
    configHome,
    projectConfig,
    settings: loaded.settings,
    trust,
    policy,
    permissionMode,
    paths,
    warnings,
    local,
  };
}
