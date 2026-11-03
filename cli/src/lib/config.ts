import { type ResolveOptions, type ResolvedConfig, resolveConfig } from "@fcx/config";

/** The trust command fcx tells people to run. The config package's default names Frontal Code's command. */
export const FCX_TRUST_COMMAND = "fcx trust";

/** `resolveConfig` with fcx's own wording in warnings. Every fcx command resolves configuration through this. */
export function resolveFcxConfig(
  cwd: string = process.cwd(),
  options: ResolveOptions = {},
): ResolvedConfig {
  return resolveConfig(cwd, { ...options, trustCommand: FCX_TRUST_COMMAND });
}
