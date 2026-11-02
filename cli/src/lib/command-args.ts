export interface CommandArgSpec {
  /** Flags that take one value: `--name <text>` or `--name=<text>`. */
  values: readonly string[];
  /** Flags that take no value. */
  flags: readonly string[];
}

export interface ParsedCommandArgs {
  positionals: string[];
  values: Map<string, string>;
  flags: Set<string>;
}

/**
 * Parses the arguments after a recipe command. Unknown flags are rejected, so a typo never changes behavior.
 * `--` ends flag parsing, so a positional that starts with a dash can still be passed.
 */
export function parseCommandArgs(
  argv: readonly string[],
  spec: CommandArgSpec,
): ParsedCommandArgs | string {
  const parsed: ParsedCommandArgs = { positionals: [], values: new Map(), flags: new Set() };
  let flagsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (flagsEnded || !arg.startsWith("-") || arg === "-") {
      parsed.positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      flagsEnded = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (spec.values.includes(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) return `${name} requires a value`;
      parsed.values.set(name, value);
    } else if (spec.flags.includes(name) && eq === -1) {
      parsed.flags.add(name);
    } else {
      return `unknown argument: ${arg}`;
    }
  }
  return parsed;
}
