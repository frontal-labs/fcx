import { DEFAULT_PERMISSION_MODE, MODE_LABELS, MODE_RANK } from "./constants.js";
import type {
  ConfigWarning,
  EffectivePolicy,
  ModeEntry,
  PermissionMode,
  ProjectConfig,
} from "./types.js";
import { isPlainObject } from "./util.js";

export function normalizePermissionMode(value: string): PermissionMode | undefined {
  return Object.hasOwn(MODE_LABELS, value) ? MODE_LABELS[value] : undefined;
}

export function lowest(modes: PermissionMode[]): PermissionMode {
  return modes.reduce((a, b) => (MODE_RANK[b] < MODE_RANK[a] ? b : a));
}

export function resolvePermissionMode(
  modes: ModeEntry[],
  projectConfig: ProjectConfig,
  policy: EffectivePolicy,
  warnings: ConfigWarning[],
  cliMode: PermissionMode | undefined,
): PermissionMode {
  let mode: PermissionMode;

  if (cliMode) {
    mode = cliMode;
  } else {
    // Project and local files can never raise the mode above the user's, or above the default when the
    // user sets none. Without this cap a trusted repo could grant itself danger-full-access.
    const userModes = modes.filter((entry) => entry.level === "user").map((entry) => entry.mode);
    const ceiling = userModes.length > 0 ? lowest(userModes) : DEFAULT_PERMISSION_MODE;
    const capped = modes.map((entry) => {
      if (entry.level === "user" || MODE_RANK[entry.mode] <= MODE_RANK[ceiling]) return entry.mode;
      warnings.push({
        key: "permissionMode",
        source: entry.path,
        reason: `capped at ${ceiling}; project and local settings cannot raise the mode above the user's`,
      });
      return ceiling;
    });
    mode = capped.length > 0 ? lowest(capped) : DEFAULT_PERMISSION_MODE;
  }

  if (projectConfig.runtime?.permission_mode !== undefined) {
    warnings.push({
      key: "runtime.permission_mode",
      source: "project.json",
      reason: "ignored: Frontal Code does not apply the project.json permission mode",
    });
  }

  if (policy.permissionCeiling && MODE_RANK[mode] > MODE_RANK[policy.permissionCeiling]) {
    mode = policy.permissionCeiling;
  }
  return mode;
}

/** `permissionMode` wins over `permissions.defaultMode`, as in the Frontal Code runtime. */
export function readSettingsMode(
  value: Record<string, unknown>,
  path: string,
  warnings: ConfigWarning[],
): PermissionMode | undefined {
  const raw =
    typeof value.permissionMode === "string"
      ? { key: "permissionMode", label: value.permissionMode }
      : isPlainObject(value.permissions) && typeof value.permissions.defaultMode === "string"
        ? { key: "permissions.defaultMode", label: value.permissions.defaultMode }
        : undefined;
  if (!raw) return undefined;
  const mode = normalizePermissionMode(raw.label);
  if (!mode) {
    warnings.push({
      key: raw.key,
      source: path,
      reason: `unrecognized value "${raw.label}" ignored`,
    });
  }
  return mode;
}
