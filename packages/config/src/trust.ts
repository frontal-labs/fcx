import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ConfigError } from "./errors.js";
import { readJsonObject } from "./json.js";
import { canonicalPath } from "./util.js";

/** A workspace is trusted when it, or a parent directory, is in `trustedWorkspaces`. */
export function checkTrust(
  configHome: string,
  workspace: string,
): { trusted: boolean; trustedRoot?: string } {
  for (const root of readTrustedWorkspaces(join(configHome, "trusted-workspaces.json"))) {
    const trustedRoot = resolve(root);
    const canonicalRoot = canonicalPath(root);
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
    if (workspace === canonicalRoot || workspace.startsWith(prefix)) {
      return { trusted: true, trustedRoot };
    }
  }
  return { trusted: false };
}

/**
 * Adds a workspace to `trusted-workspaces.json` in the config home and returns the canonical path stored.
 * Trusting a workspace lets its project settings apply and lets a language server run from its node_modules.
 */
export function trustWorkspace(configHome: string, workspace: string): string {
  const path = join(configHome, "trusted-workspaces.json");
  const root = canonicalPath(workspace);
  const roots = readTrustedWorkspaces(path);
  if (!roots.some((existing) => canonicalPath(existing) === root)) roots.push(root);
  mkdirSync(configHome, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ trustedWorkspaces: roots }, null, 2)}\n`);
  return root;
}

export function readTrustedWorkspaces(path: string): string[] {
  const content = readJsonObject(path);
  if (!content || !("trustedWorkspaces" in content)) return [];
  const roots = content.trustedWorkspaces;
  if (!Array.isArray(roots)) {
    throw new ConfigError(`${path}: expected a "trustedWorkspaces" array`);
  }
  if (!roots.every((root): root is string => typeof root === "string")) {
    throw new ConfigError(`${path}: trustedWorkspaces entries must be strings`);
  }
  return roots;
}
