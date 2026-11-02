import type { PermissionMode } from "./types.js";

/** Least to most permissive. A lower rank is always the safer choice. */
export const MODE_RANK: Record<PermissionMode, number> = {
  "read-only": 0,
  prompt: 1,
  "workspace-write": 2,
  "danger-full-access": 3,
};

/**
 * Labels accepted in settings files. The Frontal Code runtime (`parse_permission_mode_label`)
 * uses the aliases; `prompt` is fcx's own mode and is accepted as well.
 */
export const MODE_LABELS: Record<string, PermissionMode> = {
  "read-only": "read-only",
  default: "read-only",
  plan: "read-only",
  "workspace-write": "workspace-write",
  acceptEdits: "workspace-write",
  auto: "workspace-write",
  "danger-full-access": "danger-full-access",
  dontAsk: "danger-full-access",
  prompt: "prompt",
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = "prompt";

export const DEFAULT_FC_EXCLUDE = [
  "**/node_modules/**",
  "**/target/**",
  "**/.venv/**",
  "**/dist/**",
];

/** Keys that run code or widen access. Withheld from project and local settings in untrusted workspaces. */
export const WORKSPACE_CONTROLLED_KEYS = [
  "hooks",
  "mcpServers",
  "plugins",
  "enabledPlugins",
  "sandbox",
  "permissionMode",
] as const;

/** Lists that only ever tighten access. Later sources add to them rather than replace them. */
export const UNION_KEYS = new Set(["deny", "ask"]);

/** Keys that would reach Object.prototype through a plain object. Never merged. */
export const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
