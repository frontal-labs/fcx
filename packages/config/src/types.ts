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
  policy?: Record<string, unknown>;
  fc?: unknown;
  [key: string]: unknown;
}

export interface EffectivePolicy {
  allowedProviders: string[];
  allowedModels: string[];
  authMethods: string[];
  permissionCeiling: PermissionMode | null;
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

export interface ResolveOptions {
  /** Value of `--permission-mode`. Highest precedence (plan §5.2); still capped by policy. */
  permissionMode?: PermissionMode;
}

export interface ModeEntry {
  level: SettingsFile["level"];
  path: string;
  mode: PermissionMode;
}

export interface SettingsFile {
  level: "user" | "project" | "local";
  path: string;
}

export interface LoadedSettings {
  settings: MergedSettings;
  policies: Array<Record<string, unknown>>;
  modes: ModeEntry[];
}
