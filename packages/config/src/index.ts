export type PermissionMode = "read-only" | "workspace-write" | "prompt" | "danger-full-access";
export interface ResolvedConfig {
  configHome: string;
  permissionMode: PermissionMode;
  trust: { trusted: boolean; trustedRoot?: string };
  warnings: string[];
  policy?: any;
  features?: any;
  runtime?: any;
}
export function resolveConfig(cwd: string = process.cwd()): ResolvedConfig {
  const home = process.env.FRONTAL_CODE_CONFIG_HOME || process.env.FRONTAL_CODE_HOME || ((process.env.HOME || "~") + "/.frontal-code");
  return {
    configHome: home,
    permissionMode: "prompt",
    trust: { trusted: false },
    warnings: []
  };
}
export class FcError extends Error {
  code: string;
  constructor(message: string, code: string = "UNKNOWN") {
    super(message);
    this.code = code;
  }
}
export class ConfigError extends FcError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR");
  }
}
