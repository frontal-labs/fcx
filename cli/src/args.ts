import { ConfigError, type PermissionMode } from "@fcx/config";

export type OutputFormat = "text" | "json";

export interface GlobalArgs {
  command: string | undefined;
  rest: string[];
  outputFormat: OutputFormat;
  permissionMode: PermissionMode | undefined;
  cwd: string | undefined;
  dryRun: boolean;
  /** Set by --no-escalate: never offer or send a hosted escalation in this run. */
  noEscalate: boolean;
  help: boolean;
  version: boolean;
}

/** Flags accepted before or after the command. */
const GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "-h",
  "--version",
  "-v",
  "--output-format",
  "--permission-mode",
  "-C",
  "--dry-run",
  "--no-escalate",
]);

const PERMISSION_MODES: readonly PermissionMode[] = [
  "read-only",
  "workspace-write",
  "prompt",
  "danger-full-access",
];

/**
 * Parses global flags that may appear before the command. Unknown flags are
 * rejected rather than ignored, so a typo can never silently change behavior.
 */
export function parseGlobalArgs(argv: readonly string[]): GlobalArgs {
  const parsed: GlobalArgs = {
    command: undefined,
    rest: [],
    outputFormat: "text",
    permissionMode: undefined,
    cwd: undefined,
    dryRun: false,
    noEscalate: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = splitInline(arg);
    const takeValue = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith("-")) {
        throw new ConfigError(`${flag} requires a value`);
      }
      return value;
    };

    // After the command, only global flags are parsed here. Everything else belongs to the command.
    if (parsed.command !== undefined && !GLOBAL_FLAGS.has(flag)) {
      parsed.rest.push(arg);
      continue;
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--version":
      case "-v":
        parsed.version = true;
        break;
      case "--output-format": {
        const value = takeValue();
        if (value !== "text" && value !== "json") {
          throw new ConfigError(`--output-format must be "text" or "json", got "${value}"`);
        }
        parsed.outputFormat = value;
        break;
      }
      case "--permission-mode": {
        const value = takeValue();
        if (!isPermissionMode(value)) {
          throw new ConfigError(
            `--permission-mode must be one of ${PERMISSION_MODES.join(", ")}, got "${value}"`,
          );
        }
        parsed.permissionMode = value;
        break;
      }
      case "-C":
        parsed.cwd = takeValue();
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--no-escalate":
        parsed.noEscalate = true;
        break;
      default:
        if (flag.startsWith("-")) {
          throw new ConfigError(`Unknown flag: ${flag}`);
        }
        parsed.command = arg;
    }
  }

  return parsed;
}

/** Narrows a string to a permission mode, so no cast is needed at the call site. */
function isPermissionMode(value: string): value is PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

function splitInline(arg: string): [string, string | undefined] {
  if (!arg.startsWith("--")) return [arg, undefined];
  const eq = arg.indexOf("=");
  if (eq === -1) return [arg, undefined];
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}
