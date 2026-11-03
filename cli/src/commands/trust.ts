import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { configHomeFor, readEnv, trustWorkspace } from "@fcx/config";
import type { GlobalArgs } from "../args.js";
import { emit } from "../output.js";

export interface TrustReport {
  status: "ok" | "error";
  action: "trust";
  trustedRoot?: string;
  configHome?: string;
  message?: string;
}

/** `fcx trust [path]`: adds a workspace (default: the current directory) to the shared trust list. */
export function runTrustCommand(args: GlobalArgs, cwd: string): number {
  const target = resolve(cwd, args.rest[0] ?? ".");
  const configHome = configHomeFor(readEnv());

  let report: TrustReport;
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    report = { status: "error", action: "trust", message: `not a directory: ${target}` };
  } else {
    const trustedRoot = trustWorkspace(configHome, target);
    report = { status: "ok", action: "trust", trustedRoot, configHome };
  }

  emit(args.outputFormat, report, () =>
    report.status === "ok"
      ? `trusted: ${report.trustedRoot}\nProject settings and workspace language servers now apply here. Only trust code you trust.`
      : `fcx trust: ${report.message}`,
  );
  return report.status === "ok" ? 0 : 1;
}
