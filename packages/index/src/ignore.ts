/** One compiled gitignore-style rule. */
export interface IgnoreRule {
  readonly regex: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
}

/**
 * Converts a glob to a regular expression body. `**` matches across segments, `*` and `?`
 * do not cross `/`, and `**\/` matches zero or more leading directories.
 */
export function globToRegExpBody(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === "*") {
      if (glob.charAt(i + 1) === "*") {
        const followedBySlash = glob.charAt(i + 2) === "/";
        if (followedBySlash) {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
        continue;
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close > i) {
        out += glob.slice(i, close + 1).replace(/^\[!/, "[^");
        i = close + 1;
        continue;
      }
      out += "\\[";
    } else {
      out += ch.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
    i += 1;
  }
  return out;
}

/** Compiles `.gitignore`-style lines. Blank lines and comments are skipped. */
export function compileIgnoreRules(lines: readonly string[]): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "").trimEnd();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    let pattern = line;
    let negate = false;
    if (pattern.startsWith("!")) {
      negate = true;
      pattern = pattern.slice(1);
    }
    let dirOnly = false;
    if (pattern.endsWith("/")) {
      dirOnly = true;
      pattern = pattern.slice(0, -1);
    }
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }
    if (pattern.length === 0) {
      continue;
    }
    const body = globToRegExpBody(pattern);
    const source = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
    rules.push({ regex: new RegExp(source), negate, dirOnly });
  }
  return rules;
}

function matchesCandidate(
  candidate: string,
  isDir: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) {
      continue;
    }
    if (rule.regex.test(candidate)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

/**
 * True when `relPath` (POSIX, workspace-relative) is ignored. A path is ignored when any of its
 * ancestor directories is ignored, which is how gitignore treats excluded directories.
 */
export function isPathIgnored(
  relPath: string,
  isDir: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  if (rules.length === 0) {
    return false;
  }
  const segments = relPath.split("/");
  let candidate = "";
  for (let i = 0; i < segments.length - 1; i += 1) {
    candidate = i === 0 ? (segments[0] ?? "") : `${candidate}/${segments[i] ?? ""}`;
    if (matchesCandidate(candidate, true, rules)) {
      return true;
    }
  }
  return matchesCandidate(relPath, isDir, rules);
}
