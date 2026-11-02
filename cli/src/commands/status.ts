import { type ConfigWarning, type PermissionMode, resolveConfig } from "@fcx/config";
import { meta } from "../meta.js";

export interface StatusReport {
  status: "ok";
  binary: string;
  version: string;
  cwd: string;
  configHome: string;
  trust: { trusted: boolean; trustedRoot?: string };
  permissionMode: PermissionMode;
  policy: ReturnType<typeof resolveConfig>["policy"];
  paths: { cacheDir: string; logsDir: string };
  local: ReturnType<typeof resolveConfig>["local"];
  warnings: ConfigWarning[];
}

export function status(cwd: string, permissionMode?: PermissionMode): StatusReport {
  const resolved = resolveConfig(cwd, { permissionMode });
  return {
    status: "ok",
    binary: meta.binary,
    version: meta.version,
    cwd,
    configHome: resolved.configHome,
    trust: resolved.trust,
    permissionMode: resolved.permissionMode,
    policy: resolved.policy,
    paths: resolved.paths,
    local: resolved.local,
    warnings: resolved.warnings,
  };
}

export function formatStatus(report: StatusReport): string {
  const lines = [
    `${report.binary} ${report.version}`,
    `workspace:       ${report.cwd}`,
    `config home:     ${report.configHome}`,
    `trusted:         ${report.trust.trusted ? `yes (${report.trust.trustedRoot})` : "no"}`,
    `permission mode: ${report.permissionMode}`,
    `model:           ${report.local.model ?? "ggml/auto"}`,
    `cache dir:       ${report.paths.cacheDir}`,
    `logs dir:        ${report.paths.logsDir}`,
  ];
  for (const w of report.warnings) {
    lines.push(`warning: ${w.key} (${w.source}): ${w.reason}`);
  }
  return lines.join("\n");
}
