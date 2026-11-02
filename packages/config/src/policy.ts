import { lowest, normalizePermissionMode } from "./permissions.js";
import type { ConfigWarning, EffectivePolicy, PermissionMode } from "./types.js";

/**
 * Combines policy from every settings file. Allow-lists intersect (a source that
 * does not set one doesn't restrict it), denies union, and the ceiling is the lowest.
 */
export function intersectPolicy(
  policies: Array<Record<string, unknown>>,
  warnings: ConfigWarning[],
): EffectivePolicy {
  const providers: string[][] = [];
  const models: string[][] = [];
  const auth: string[][] = [];
  const deny = new Set<string>();
  const ceilings: PermissionMode[] = [];

  for (const policy of policies) {
    const p = stringList(policy.allowedProviders);
    if (p) providers.push(p);
    const m = stringList(policy.allowedModels);
    if (m) models.push(m);
    const a = stringList(policy.authMethods);
    if (a) auth.push(a);
    for (const rule of stringList(policy.deny) ?? []) deny.add(rule);
    if (policy.permissionCeiling !== undefined) {
      const ceiling =
        typeof policy.permissionCeiling === "string"
          ? normalizePermissionMode(policy.permissionCeiling)
          : undefined;
      if (ceiling) {
        ceilings.push(ceiling);
      } else {
        warnings.push({
          key: "policy.permissionCeiling",
          source: "settings",
          reason: `unrecognized value "${String(policy.permissionCeiling)}" ignored`,
        });
      }
    }
  }

  return {
    allowedProviders: intersect(providers),
    allowedModels: intersect(models),
    authMethods: intersect(auth),
    permissionCeiling: ceilings.length > 0 ? lowest(ceilings) : null,
    deny: [...deny],
  };
}

export function intersect(lists: string[][]): string[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  return rest.reduce((acc, list) => acc.filter((item) => list.includes(item)), first);
}

export function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return undefined;
}
