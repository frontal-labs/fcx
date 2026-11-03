import { readFileSync } from "node:fs";
import { resolveInWorkspace } from "@fcx/apply";

/*
 * Layer 5 (explanations): a claim is kept only when it cites a real range and every identifier it mentions
 * appears in the cited text. Claims that fail are dropped, never repaired. The caller may regenerate once
 * when more than half the claims were dropped.
 */

/** A 1-based, inclusive line range in a file. */
export interface Citation {
  file: string;
  start: number;
  end: number;
}

export interface Claim {
  text: string;
  cites: readonly Citation[];
}

export interface CiteOptions {
  /** Absolute workspace root. Relative citation paths resolve against it, and citations outside it are dropped. */
  workspace: string;
  /** Reads a file by absolute path. Defaults to reading from disk as UTF-8. Throwing means the file is missing. */
  readFile?: (path: string) => string;
}

export type CiteReasonCode =
  | "NO_CITATION"
  | "FILE_OUTSIDE_WORKSPACE"
  | "FILE_NOT_FOUND"
  | "RANGE_INVALID"
  | "RANGE_OUT_OF_BOUNDS"
  | "NO_IDENTIFIER"
  | "IDENTIFIER_NOT_IN_CITATION";

export interface CiteResult {
  kept: Claim[];
  dropped: { claim: Claim; reasonCode: CiteReasonCode }[];
  /** True when more than half of the claims were dropped. The caller may regenerate once. */
  regenerate: boolean;
}

/** A citation whose range exists, with its text. */
interface ResolvedCitation {
  text: string;
}

type Resolution =
  | { ok: true; citation: ResolvedCitation }
  | { ok: false; reasonCode: CiteReasonCode };

/**
 * Identifiers a claim asserts about the code. Prose words ("returns", "the") are not checked, because
 * they are not claims about code. A word is code-like when it is in backticks, is called (`name(`),
 * is the base or member of a dotted access (`item.price`), or contains `_` or `$`, or is camelCase.
 */
export function codeIdentifiers(text: string): Set<string> {
  const found = new Set<string>();
  const add = (word: string | undefined): void => {
    if (word !== undefined) found.add(word);
  };
  for (const match of text.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)) add(match[1]);
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\(/g)) add(match[1]);
  for (const match of text.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\.[A-Za-z_$]/g)) add(match[1]);
  for (const match of text.matchAll(/\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) add(match[1]);
  for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    const word = match[0];
    if (/[_$]/.test(word) || /[a-z][A-Z]/.test(word)) found.add(word);
  }
  return found;
}

/**
 * Quoted literals a claim asserts, when they look like code: a path, package or id with a separator
 * ('ggml/auto', "max-tokens", 'v1.5'). Prose in quotes is not checked. A literal must appear verbatim in the cited text.
 */
export function quotedLiterals(text: string): Set<string> {
  const found = new Set<string>();
  // Opening and closing quotes must not touch a letter or digit, so contractions like don't/won't are prose.
  for (const match of text.matchAll(/(?<![A-Za-z0-9])(["'])([^"'\s]+)\1(?![A-Za-z0-9])/g)) {
    if (/[/._-]/.test(match[2])) found.add(match[2]);
  }
  return found;
}

/**
 * Code names in `text` (identifiers and quoted literals, as the cite layer finds them) that `shown` does not
 * contain. Prose is not checked. An empty list means every code name in `text` was shown.
 */
export function unshownNames(text: string, shown: string): string[] {
  const missing: string[] = [];
  for (const identifier of codeIdentifiers(text)) {
    if (!containsWord(shown, identifier)) missing.push(identifier);
  }
  for (const literal of quotedLiterals(text)) {
    if (!shown.includes(literal)) missing.push(literal);
  }
  return missing.sort();
}

export function cite(claims: readonly Claim[], options: CiteOptions): CiteResult {
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const files = new Map<string, string | null>();
  const load = (path: string): string | null => {
    if (!files.has(path)) {
      let text: string | null;
      try {
        text = read(path);
      } catch {
        text = null;
      }
      files.set(path, text);
    }
    return files.get(path) ?? null;
  };

  const kept: Claim[] = [];
  const dropped: CiteResult["dropped"] = [];

  for (const claim of claims) {
    const verdict = judge(claim, options.workspace, load);
    if (verdict.ok) {
      kept.push(claim);
    } else {
      dropped.push({ claim, reasonCode: verdict.reasonCode });
    }
  }

  return { kept, dropped, regenerate: dropped.length * 2 > claims.length };
}

function judge(
  claim: Claim,
  workspace: string,
  load: (path: string) => string | null,
): { ok: true } | { ok: false; reasonCode: CiteReasonCode } {
  if (claim.cites.length === 0) return { ok: false, reasonCode: "NO_CITATION" };

  // Invalid citations are discarded. The claim stands only on the ranges that exist.
  const surviving: string[] = [];
  let firstFailure: CiteReasonCode | undefined;
  for (const citation of claim.cites) {
    const resolved = resolveCitation(citation, workspace, load);
    if (resolved.ok) {
      surviving.push(resolved.citation.text);
    } else {
      firstFailure ??= resolved.reasonCode;
    }
  }
  if (surviving.length === 0) {
    return { ok: false, reasonCode: firstFailure ?? "NO_CITATION" };
  }

  const span = surviving.join("\n");
  const identifiers = codeIdentifiers(claim.text);
  // A claim with nothing to check ("The registry holds some data") would pass every other test. It must name code.
  if (identifiers.size === 0 && quotedLiterals(claim.text).size === 0) {
    return { ok: false, reasonCode: "NO_IDENTIFIER" };
  }
  for (const identifier of identifiers) {
    if (!containsWord(span, identifier)) {
      return { ok: false, reasonCode: "IDENTIFIER_NOT_IN_CITATION" };
    }
  }
  for (const literal of quotedLiterals(claim.text)) {
    if (!span.includes(literal)) {
      return { ok: false, reasonCode: "IDENTIFIER_NOT_IN_CITATION" };
    }
  }
  return { ok: true };
}

function resolveCitation(
  citation: Citation,
  workspace: string,
  load: (path: string) => string | null,
): Resolution {
  let path: string;
  try {
    path = resolveInWorkspace(workspace, citation.file);
  } catch {
    return { ok: false, reasonCode: "FILE_OUTSIDE_WORKSPACE" };
  }
  const text = load(path);
  if (text === null) return { ok: false, reasonCode: "FILE_NOT_FOUND" };

  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const { start, end } = citation;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
    return { ok: false, reasonCode: "RANGE_INVALID" };
  }
  if (end > lines.length) return { ok: false, reasonCode: "RANGE_OUT_OF_BOUNDS" };
  return { ok: true, citation: { text: lines.slice(start - 1, end).join("\n") } };
}

/** Case-sensitive, whole-word match. `$` counts as part of a word, as it does in JavaScript identifiers. */
export function containsWord(text: string, word: string): boolean {
  const escaped = word.replace(/\\/g, "\\\\").replace(/[$]/g, "\\$");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(text);
}
