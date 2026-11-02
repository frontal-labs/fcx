import { readFile } from "node:fs/promises";
import { join } from "node:path";

const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Sorted package names declared by the workspace's package.json. Empty when there is none. */
export async function declaredPackages(workspace: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
  } catch {
    return [];
  }
  if (!isRecord(parsed)) {
    return [];
  }
  const names = new Set<string>();
  for (const section of SECTIONS) {
    const deps = parsed[section];
    if (isRecord(deps)) {
      for (const name of Object.keys(deps)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}
