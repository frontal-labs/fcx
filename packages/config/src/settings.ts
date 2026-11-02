import { dirname, join } from "node:path";
import { UNION_KEYS, UNSAFE_KEYS, WORKSPACE_CONTROLLED_KEYS } from "./constants.js";
import { readJsonObject } from "./json.js";
import { readSettingsMode } from "./permissions.js";
import type {
  ConfigWarning,
  LoadedSettings,
  MergedSettings,
  ModeEntry,
  SettingsFile,
} from "./types.js";
import { isPlainObject } from "./util.js";

export function settingsFiles(configHome: string, workspace: string): SettingsFile[] {
  const files: SettingsFile[] = [];
  const userPath = join(configHome, "settings.json");
  const legacyPath = join(dirname(configHome), ".frontal-code", "settings.json");
  if (legacyPath !== userPath) files.push({ level: "user", path: legacyPath });
  files.push({ level: "user", path: userPath });
  files.push({ level: "project", path: join(workspace, ".frontal-code", "settings.json") });
  files.push({ level: "local", path: join(workspace, ".frontal-code", "settings.local.json") });
  return files;
}

/**
 * Reads every settings file, applies workspace trust, and deep-merges the result.
 * Malformed JSON is an error, not a warning, as in Frontal Code.
 */
export function loadSettings(
  configHome: string,
  workspace: string,
  trusted: boolean,
  warnings: ConfigWarning[],
): LoadedSettings {
  const merged: Record<string, unknown> = {};
  const policies: Array<Record<string, unknown>> = [];
  const modes: ModeEntry[] = [];
  let userPolicy: Record<string, unknown> | undefined;

  for (const file of settingsFiles(configHome, workspace)) {
    const content = readJsonObject(file.path);
    if (!content) continue;
    const value: Record<string, unknown> = { ...content };
    const restricted = file.level !== "user";

    if (restricted && !trusted) {
      for (const key of withholdWorkspaceControlled(value)) {
        warnings.push({
          key,
          source: file.path,
          reason: "withheld until this workspace is trusted; run `frontal-code trust` to enable",
        });
      }
    }

    if (restricted) {
      // Project and local files can tighten access but never grant allow rules.
      if (takeAllowRules(value).allow.length > 0) {
        warnings.push({
          key: "permissions.allow",
          source: file.path,
          reason: "ignored: project and local settings can only restrict access (use deny or ask)",
        });
      }
      prunePermissions(value);
    }

    const policy = value.policy;
    if (isPlainObject(policy)) {
      policies.push(policy);
      if (file.level === "user") userPolicy = policy;
    }

    const mode = readSettingsMode(value, file.path, warnings);
    if (mode) modes.push({ level: file.level, path: file.path, mode });

    deepMerge(merged, value);
  }

  // settings.policy in the output reflects user-level settings only.
  Reflect.deleteProperty(merged, "policy");
  if (userPolicy) merged.policy = userPolicy;

  return { settings: merged as MergedSettings, policies, modes };
}

/** Removes workspace-controlled keys, in the order they appear in the file. */
export function withholdWorkspaceControlled(value: Record<string, unknown>): string[] {
  const withheld: string[] = [];
  const controlled = new Set<string>(WORKSPACE_CONTROLLED_KEYS);
  for (const key of Object.keys(value)) {
    if (controlled.has(key)) {
      Reflect.deleteProperty(value, key);
      withheld.push(key);
    }
  }
  const perms = value.permissions;
  if (isPlainObject(perms) && "defaultMode" in perms) {
    Reflect.deleteProperty(perms, "defaultMode");
    withheld.push("permissions.defaultMode");
  }
  return withheld;
}

/** Drops empty rule lists and an empty `permissions` object. Allow rules were already removed. */
export function prunePermissions(value: Record<string, unknown>): void {
  const perms = value.permissions;
  if (!isPlainObject(perms)) return;
  for (const [key, rules] of Object.entries(perms)) {
    if (Array.isArray(rules) && rules.length === 0) Reflect.deleteProperty(perms, key);
  }
  if (Object.keys(perms).length === 0) Reflect.deleteProperty(value, "permissions");
}

/** Removes `permissions.allow` from a file and returns its rules. Only user settings may grant allow rules. */
export function takeAllowRules(value: Record<string, unknown>): { allow: string[] } {
  const perms = value.permissions;
  if (!isPlainObject(perms) || !Array.isArray(perms.allow)) return { allow: [] };
  const allow = perms.allow.filter((rule): rule is string => typeof rule === "string");
  Reflect.deleteProperty(perms, "allow");
  return { allow };
}

/**
 * Deep-merges `source` into `target`. Reads only own properties, and skips prototype-reaching keys,
 * so a settings file cannot pollute Object.prototype.
 */
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (UNSAFE_KEYS.has(key)) continue;
    const existing = Object.hasOwn(target, key) ? target[key] : undefined;
    if (isPlainObject(existing) && isPlainObject(value)) {
      deepMerge(existing, value);
    } else if (Array.isArray(existing) && Array.isArray(value) && UNION_KEYS.has(key)) {
      target[key] = [...new Set([...existing, ...value])];
    } else if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {};
      target[key] = copy;
      deepMerge(copy, value);
    } else {
      target[key] = value;
    }
  }
}
