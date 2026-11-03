import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type PermissionMode, resolveConfig } from "@fcx/config";
import { type DetectedServer, detectServers } from "@fcx/lsp";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  status: "ok" | "warn" | "fail";
  checks: Check[];
}

const MIN_NODE_MAJOR = 22;

export async function doctor(cwd: string, permissionMode?: PermissionMode): Promise<DoctorReport> {
  const resolved = resolveConfig(cwd, { permissionMode });
  const checks: Check[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    status: nodeMajor >= MIN_NODE_MAJOR ? "ok" : "fail",
    detail: `node ${process.versions.node} (requires >= ${MIN_NODE_MAJOR})`,
  });

  checks.push({
    name: "config-home",
    status: existsSync(resolved.configHome) ? "ok" : "warn",
    detail: existsSync(resolved.configHome)
      ? resolved.configHome
      : `${resolved.configHome} does not exist; defaults are in use`,
  });

  checks.push({
    name: "workspace-trust",
    status: resolved.trust.trusted ? "ok" : "warn",
    detail: resolved.trust.trusted
      ? `trusted (${resolved.trust.trustedRoot})`
      : "untrusted: project and local settings are restricted; run `fcx trust`",
  });

  const allowed = resolved.policy.allowedProviders;
  const ggmlAllowed = allowed.length === 0 || allowed.includes("ggml");
  checks.push({
    name: "policy-ggml-provider",
    status: ggmlAllowed ? "ok" : "fail",
    detail: ggmlAllowed
      ? "local ggml provider is allowed by policy"
      : `policy.allowedProviders excludes "ggml". Add "ggml" to allowedProviders in settings to run the local model`,
  });

  checks.push(checkGgmlNode());

  checks.push(await checkLanguageServers(resolve(cwd), resolved.trust.trusted));

  const worst = checks.reduce<CheckStatus>(
    (acc, c) =>
      c.status === "fail" || acc === "fail"
        ? "fail"
        : c.status === "warn" || acc === "warn"
          ? "warn"
          : "ok",
    "ok",
  );
  return { status: worst, checks };
}

function checkGgmlNode(): Check {
  try {
    // Resolution only: loading ggml-node would pull in native code, which doctor does not need.
    const entry = import.meta.resolve("ggml-node");
    return { name: "ggml-node", status: "ok", detail: `resolved ${entry}` };
  } catch {
    return {
      name: "ggml-node",
      status: "fail",
      detail: "ggml-node is not installed; the local model cannot run",
    };
  }
}

export function formatDoctor(report: DoctorReport): string {
  return report.checks
    .map((c) => `[${c.status.toUpperCase().padEnd(4)}] ${c.name}: ${c.detail}`)
    .join("\n");
}

/**
 * Reports which language servers resolve for the workspace. A server binary inside the workspace's own
 * node_modules is only used when the workspace is trusted, so an untrusted workspace that has one gets a warning.
 */
export async function checkLanguageServers(workspace: string, trusted: boolean): Promise<Check> {
  try {
    const servers = await detectServers(workspace, { trustWorkspace: trusted });
    const blocked = trusted ? [] : await workspaceBinariesBlocked(workspace);
    const available = servers.filter(isAvailable);
    if (blocked.length > 0) {
      return {
        name: "language-servers",
        status: "warn",
        detail: `workspace language server found for ${blocked.join(", ")}, but the workspace is untrusted, so it is ignored; run \`fcx trust\``,
      };
    }
    if (available.length === 0) {
      return {
        name: "language-servers",
        status: "warn",
        detail: "no language server found on PATH or in the workspace",
      };
    }
    return {
      name: "language-servers",
      status: "ok",
      detail: available.map((s) => `${s.language} (${s.source})`).join(", "),
    };
  } catch (error) {
    return {
      name: "language-servers",
      status: "warn",
      detail: `could not check language servers: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function isAvailable(
  server: DetectedServer,
): server is Extract<DetectedServer, { available: true }> {
  return server.available;
}

/** Languages whose server would resolve to a binary in the untrusted workspace's node_modules. */
async function workspaceBinariesBlocked(workspace: string): Promise<string[]> {
  const probe = await detectServers(workspace, { trustWorkspace: true });
  return probe
    .filter(
      (s): s is Extract<DetectedServer, { available: true }> =>
        isAvailable(s) && s.source === "workspace",
    )
    .map((s) => s.language);
}
