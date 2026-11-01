import { readFileSync, statSync } from "node:fs";

export type PermissionMode = "read-only" | "workspace-write" | "prompt" | "danger-full-access";

export interface ProjectConfig {
  project?: unknown;
  runtime?: {
    default_provider?: string;
    providers?: Record<string, { enabled?: boolean; default_model?: string }>;
    permission_mode?: string;
    log_level?: string;
    max_concurrent_requests?: number;
    request_timeout_seconds?: number;
  };
  paths?: { config_home?: string; home?: string; cache_dir?: string; logs_dir?: string };
  features?: { max_memory_usage_mb?: number; enable_telemetry?: boolean };
  ui?: unknown;
  services?: { memory?: unknown };
  sandbox?: unknown;
  experimental?: unknown;
}

export interface MergedSettings {
  hooks?: unknown;
  mcpServers?: unknown;
  plugins?: unknown;
  enabledPlugins?: unknown;
  sandbox?: unknown;
  permissionMode?: string;
  permissions?: { defaultMode?: string; ask?: string[]; deny?: string[] };
  allow?: string[];
  policy?: {
    allowedProviders?: string[];
    allowedModels?: string[];
    authMethods?: string[];
    permissionCeiling?: string;
    deny?: string[];
  };
  [key: string]: unknown;
}

export interface EffectivePolicy {
  allowedProviders: string[];
  allowedModels: string[];
  authMethods: string[];
  permissionCeiling: PermissionMode | undefined;
  deny: string[];
}

export interface FcSettings {
  model?: string;
  embeddingModel?: string;
  maxCandidates?: number | "auto";
  contextBudgetTokens?: number;
  languages?: string[];
  index?: { exclude?: string[] };
  escalation?: { enabled: boolean; provider?: string };
  telemetry?: "inherit" | boolean;
}

export interface ConfigWarning {
  key: string;
  source: string;
  reason: string;
}

export interface ResolvedConfig {
  configHome: string;
  projectConfig: ProjectConfig;
  settings: MergedSettings;
  trust: { trusted: boolean; trustedRoot?: string };
  policy: EffectivePolicy;
  permissionMode: PermissionMode;
  paths: { cacheDir: string; logsDir: string };
  warnings: ConfigWarning[];
  local: FcSettings;
}

export class FcError extends Error {
  readonly code: string;
  constructor(message: string, code = "UNKNOWN", hint?: string) {
    super(message);
    this.name = "FcError";
    this.code = code;
    this.hint = hint;
  }
  readonly hint?: string;
}

export class ConfigError extends FcError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
    this.name = "ConfigError";
  }
}

const DEFAULT_PERMISSION_MODE: PermissionMode = "prompt";
const CONFIG_HOME_ENV_CHAIN = ["FRONTAL_CODE_CONFIG_HOME", "FRONTAL_CODE_HOME"];
const DEFAULT_CONFIG_HOME = "~/.frontal-code";

const PROJECT_JSON_LOCATIONS = [
  "$FRONTAL_CODE_CONFIG_HOME/project.json",
  "$FRONTAL_CODE_HOME/project.json",
  "~/.frontal-code/project.json",
  "config/project.json",
];

const SETTINGS_FILES = [
  { path: "~/.frontal-code/settings.json", level: "user" },
  { path: ".frontal-code/settings.json", level: "project" },
  { path: ".frontal-code/settings.local.json", level: "local" },
];

const TRUSTED_KEYS_WITHHELD = [
  "hooks",
  "mcpServers",
  "plugins",
  "enabledPlugins",
  "sandbox",
  "permissionMode",
  "permissions.defaultMode",
];

export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig {
  const warnings: ConfigWarning[] = [];
  const configHome = expandHome(resolveConfigHome());

  const projectConfig = findProjectConfig(configHome, cwd);
  const trust = checkTrust(configHome, cwd);
  const settings = mergeSettings(configHome, cwd, trust, warnings);
  const local: FcSettings = extractFcSettings(settings, trust, warnings);
  const policy = intersectPolicy([projectConfig, settings], warnings);
  const permissionMode = resolvePermissionMode(projectConfig, settings, policy, warnings);
  const paths = resolvePaths(projectConfig, configHome);

  return {
    configHome,
    projectConfig,
    settings,
    trust,
    policy,
    permissionMode,
    paths,
    warnings,
    local,
  };
}

function resolveConfigHome(): string {
  for (const env of CONFIG_HOME_ENV_CHAIN) {
    const val = process.env[env];
    if (val) return val;
  }
  return DEFAULT_CONFIG_HOME;
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return (process.env.HOME || "/") + path.slice(1);
  }
  if (path === "~") {
    return process.env.HOME || "/";
  }
  return path;
}

function findProjectConfig(configHome: string, cwd: string): ProjectConfig {
  const locations = PROJECT_JSON_LOCATIONS.map((loc) =>
    loc
      .replace("$FRONTAL_CODE_CONFIG_HOME", configHome)
      .replace("$FRONTAL_CODE_HOME", configHome)
      .replace("~", process.env.HOME || "/"),
  );

  const workspaceRoot = findWorkspaceRoot(cwd);
  if (workspaceRoot) {
    locations.push(`${workspaceRoot}/config/project.json`);
  }

  for (const loc of locations) {
    try {
      const content = readJsonFile(loc);
      if (content && typeof content === "object" && content !== null) {
        return content as ProjectConfig;
      }
    } catch {
      // continue to next location
    }
  }
  return {};
}

function findWorkspaceRoot(cwd: string): string | undefined {
  let dir = cwd;
  const root = process.env.HOME || "/";
  while (dir && dir !== root) {
    if (fileExists(`${dir}/.frontal-code`) || fileExists(`${dir}/.git`)) {
      return dir;
    }
    const parent = dir.lastIndexOf("/");
    if (parent <= 0) break;
    dir = dir.slice(0, parent);
  }
  if (fileExists(`${root}/.frontal-code`) || fileExists(`${root}/.git`)) return root;
  return undefined;
}

function checkTrust(configHome: string, cwd: string): { trusted: boolean; trustedRoot?: string } {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (!workspaceRoot) return { trusted: false };

  const trustFile = `${configHome}/trusted-workspaces.json`;
  let trusted: string[] = [];
  try {
    const content = readJsonFile(trustFile);
    if (
      content &&
      typeof content === "object" &&
      content !== null &&
      Array.isArray((content as { trusted?: string[] }).trusted)
    ) {
      trusted = (content as { trusted: string[] }).trusted;
    }
  } catch {
    // no trust file, not trusted
  }

  let dir: string | null = workspaceRoot;
  while (dir) {
    if (trusted.includes(dir)) {
      return { trusted: true, trustedRoot: dir };
    }
    if (dir === "/" || dir === process.env.HOME) break;
    const parent = dir.lastIndexOf("/");
    dir = parent <= 0 ? null : dir.slice(0, parent);
  }
  return { trusted: false };
}

function mergeSettings(
  configHome: string,
  cwd: string,
  trust: { trusted: boolean },
  warnings: ConfigWarning[],
): MergedSettings {
  const merged: MergedSettings = {};
  const isProjectOrLocal = (_level: string) => _level === "project" || _level === "local";

  for (const { path, level } of SETTINGS_FILES) {
    const fullPath = expandHome(path);
    let content: Record<string, unknown>;
    try {
      const raw = readJsonFile(fullPath);
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        continue;
      }
      content = raw as Record<string, unknown>;
    } catch {
      continue;
    }

    const projOrLocal = isProjectOrLocal(level);
    if (projOrLocal && !trust.trusted) {
      for (const key of Object.keys(content)) {
        if (TRUSTED_KEYS_WITHHELD.includes(key) || key === "permissions") {
          warnings.push({
            key,
            source: fullPath,
            reason: "untrusted workspace",
          });
          continue;
        }
        merged[key] = content[key];
      }
      continue;
    }

    for (const [key, value] of Object.entries(content)) {
      if (key === "permissions" && typeof value === "object" && value !== null) {
        const perms = value as Record<string, unknown>;
        if ("allow" in perms && projOrLocal && !trust.trusted) {
          warnings.push({
            key: "permissions.allow",
            source: fullPath,
            reason: "ignored (project/local allow rules are always ignored)",
          });
          perms.allow = undefined;
        }
        merged[key] = perms;
      } else {
        merged[key] = value;
      }
    }
  }

  return merged;
}

function extractFcSettings(
  settings: MergedSettings,
  _trust: { trusted: boolean },
  _warnings: ConfigWarning[],
): FcSettings {
  const fc = settings.fc;
  if (!fc || typeof fc !== "object" || fc === null) {
    return {
      model: "ggml/auto",
      embeddingModel: "ggml/bge-small-en-v1.5",
      maxCandidates: "auto",
      contextBudgetTokens: 3000,
      languages: ["typescript", "python", "go", "rust"],
      index: { exclude: ["**/node_modules/**", "**/target/**", "**/.venv/**", "**/dist/**"] },
      escalation: { enabled: true, provider: "default" },
      telemetry: "inherit",
    };
  }

  const fcObj = fc as Record<string, unknown>;
  const result: FcSettings = {
    model: typeof fcObj.model === "string" ? fcObj.model : "ggml/auto",
    embeddingModel:
      typeof fcObj.embeddingModel === "string" ? fcObj.embeddingModel : "ggml/bge-small-en-v1.5",
    maxCandidates:
      typeof fcObj.maxCandidates === "number" || fcObj.maxCandidates === "auto"
        ? (fcObj.maxCandidates as number | "auto")
        : "auto",
    contextBudgetTokens:
      typeof fcObj.contextBudgetTokens === "number" ? fcObj.contextBudgetTokens : 3000,
    languages: Array.isArray(fcObj.languages)
      ? fcObj.languages.filter((l): l is string => typeof l === "string")
      : ["typescript", "python", "go", "rust"],
    escalation:
      typeof fcObj.escalation === "object" && fcObj.escalation !== null
        ? {
            enabled:
              typeof (fcObj.escalation as Record<string, unknown>).enabled === "boolean"
                ? ((fcObj.escalation as Record<string, unknown>).enabled as boolean)
                : true,
            provider:
              typeof (fcObj.escalation as Record<string, unknown>).provider === "string"
                ? ((fcObj.escalation as Record<string, unknown>).provider as string)
                : "default",
          }
        : { enabled: true, provider: "default" },
    telemetry:
      typeof fcObj.telemetry === "string" ? (fcObj.telemetry as "inherit" | boolean) : "inherit",
  };

  if (fcObj.index && typeof fcObj.index === "object" && fcObj.index !== null) {
    const idx = fcObj.index as Record<string, unknown>;
    result.index = {
      exclude: Array.isArray(idx.exclude)
        ? idx.exclude.filter((e): e is string => typeof e === "string")
        : ["**/node_modules/**", "**/target/**", "**/.venv/**", "**/dist/**"],
    };
  } else {
    result.index = {
      exclude: ["**/node_modules/**", "**/target/**", "**/.venv/**", "**/dist/**"],
    };
  }

  return result;
}

function intersectPolicy(
  sources: Array<ProjectConfig | MergedSettings>,
  warnings: ConfigWarning[],
): EffectivePolicy {
  const result: EffectivePolicy = {
    allowedProviders: [],
    allowedModels: [],
    authMethods: [],
    permissionCeiling: undefined,
    deny: [],
  };

  let first = true;
  for (const source of sources) {
    let policy: Record<string, unknown> | undefined;
    if ("policy" in source && source.policy && typeof source.policy === "object") {
      policy = source.policy as Record<string, unknown>;
    }

    if (!policy) continue;

    const providers =
      typeof policy.allowedProviders === "string"
        ? [policy.allowedProviders]
        : Array.isArray(policy.allowedProviders)
          ? [...(policy.allowedProviders as string[])]
          : undefined;
    const models =
      typeof policy.allowedModels === "string"
        ? [policy.allowedModels]
        : Array.isArray(policy.allowedModels)
          ? [...(policy.allowedModels as string[])]
          : undefined;
    const auth =
      typeof policy.authMethods === "string"
        ? [policy.authMethods]
        : Array.isArray(policy.authMethods)
          ? [...(policy.authMethods as string[])]
          : undefined;
    const deny =
      typeof policy.deny === "string"
        ? [policy.deny]
        : Array.isArray(policy.deny)
          ? [...(policy.deny as string[])]
          : undefined;

    if (first) {
      if (providers) result.allowedProviders = providers;
      if (models) result.allowedModels = models;
      if (auth) result.authMethods = auth;
      if (deny) result.deny = deny;
      if (typeof policy.permissionCeiling === "string") {
        result.permissionCeiling = normalizePermissionMode(policy.permissionCeiling);
      }
      first = false;
    } else {
      if (providers) {
        result.allowedProviders = result.allowedProviders.filter((p) => providers.includes(p));
      }
      if (models) {
        result.allowedModels = result.allowedModels.filter((m) => models.includes(m));
      }
      if (auth) {
        result.authMethods = result.authMethods.filter((a) => auth.includes(a));
      }
      if (deny) {
        result.deny = [...new Set([...result.deny, ...deny])];
      }
      if (typeof policy.permissionCeiling === "string") {
        const ceiling = normalizePermissionMode(policy.permissionCeiling);
        if (ceiling && result.permissionCeiling) {
          result.permissionCeiling = minPermissionMode(result.permissionCeiling, ceiling);
        } else if (ceiling) {
          result.permissionCeiling = ceiling;
        }
      }
    }
  }

  return result;
}

function resolvePermissionMode(
  projectConfig: ProjectConfig,
  settings: MergedSettings,
  policy: EffectivePolicy,
  warnings: ConfigWarning[],
): PermissionMode {
  let mode: PermissionMode | undefined;

  const envMode = process.env.RUSTY_CLAUDE_PERMISSION_MODE;
  if (envMode) {
    const parsed = normalizePermissionMode(envMode);
    if (parsed) {
      mode = parsed;
    } else {
      warnings.push({
        key: "RUSTY_CLAUDE_PERMISSION_MODE",
        source: "env",
        reason: "unrecognized value ignored",
      });
    }
  }

  if (!mode && typeof settings.permissionMode === "string") {
    const parsed = normalizePermissionMode(settings.permissionMode);
    if (parsed) {
      mode = parsed;
    } else {
      warnings.push({
        key: "permissionMode",
        source: "settings",
        reason: "unrecognized value ignored",
      });
    }
  }

  if (!mode && projectConfig.runtime?.permission_mode) {
    const parsed = normalizePermissionMode(projectConfig.runtime.permission_mode);
    if (parsed) {
      mode = parsed;
    } else {
      warnings.push({
        key: "permission_mode",
        source: "project.json",
        reason: "unrecognized value ignored",
      });
    }
  }

  if (!mode) {
    mode = DEFAULT_PERMISSION_MODE;
  }

  if (policy.permissionCeiling && mode) {
    const ceiling = policy.permissionCeiling;
    if (ceiling !== "danger-full-access") {
      mode = minPermissionMode(mode, ceiling);
    }
  }

  return mode;
}

function normalizePermissionMode(value: string): PermissionMode | undefined {
  switch (value) {
    case "read-only":
    case "workspace-write":
    case "prompt":
    case "danger-full-access":
      return value;
    default:
      return undefined;
  }
}

function minPermissionMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  const rank: Record<PermissionMode, number> = {
    "read-only": 0,
    "workspace-write": 1,
    prompt: 2,
    "danger-full-access": 3,
  };
  return rank[a] <= rank[b] ? a : b;
}

function resolvePaths(
  projectConfig: ProjectConfig,
  configHome: string,
): { cacheDir: string; logsDir: string } {
  const cacheDir = projectConfig.paths?.cache_dir
    ? expandHome(projectConfig.paths.cache_dir)
    : `${configHome}/cache`;
  const logsDir = projectConfig.paths?.logs_dir
    ? expandHome(projectConfig.paths.logs_dir)
    : `${configHome}/logs`;
  return { cacheDir, logsDir };
}

function readJsonFile(path: string): unknown {
  const content = readFileSync(path, "utf-8");
  return JSON.parse(content);
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
