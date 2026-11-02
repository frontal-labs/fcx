import { type LayerOutcome, ground } from "@fcx/defense";
import { type Checker, type Diagnostic, errorsOnly } from "@fcx/verify";
import { relativeTo } from "./context.js";

/** A 1-based inclusive line range in a candidate file. */
export interface LineSpan {
  readonly first: number;
  readonly last: number;
}

/**
 * Ground layer for TypeScript files: every identifier in the changed lines must resolve. Non-TypeScript files
 * are passed through, since only the TypeScript checker runs in process.
 */
export function groundLayer(
  checker: Checker,
  texts: ReadonlyMap<string, string>,
  original: (path: string) => string | undefined,
): LayerOutcome {
  const t0 = performance.now();
  for (const [path, candidate] of texts) {
    const outcome = ground({
      checker,
      file: path,
      originalText: original(path) ?? "",
      candidateText: candidate,
    });
    if (!outcome.pass) return outcome;
  }
  return { layer: "ground", pass: true, ms: Math.round(performance.now() - t0) };
}

/**
 * Verify layer for type checks without a single target. No candidate file may gain an error it did not have
 * before, and no error may remain inside `spans` (the lines a function or selection now occupies).
 * Errors are compared per (code, message), as the defense verify layer does.
 */
export function typeCheckLayer(options: {
  checker: Checker;
  workspace: string;
  texts: ReadonlyMap<string, string>;
  original: (path: string) => string | undefined;
  spans?: ReadonlyMap<string, LineSpan>;
}): LayerOutcome {
  const t0 = performance.now();
  const fail = (reasonCode: string, feedback: string): LayerOutcome => ({
    layer: "verify",
    pass: false,
    ms: Math.round(performance.now() - t0),
    reasonCode,
    feedback,
  });
  const key = (d: Diagnostic) => `${d.code}:${d.message}`;
  const countIn = (list: readonly Diagnostic[], k: string) =>
    list.filter((d) => key(d) === k).length;

  // Baselines first: a diagnostics call without overrides reads the files as they are on disk.
  const baselines = new Map<string, Diagnostic[]>();
  for (const path of options.texts.keys()) {
    const before =
      options.original(path) === undefined ? [] : errorsOnly(options.checker.diagnostics(path));
    baselines.set(path, before);
  }

  const overrides = new Map(options.texts);
  for (const path of options.texts.keys()) {
    const after = errorsOnly(options.checker.diagnostics(path, overrides));
    const before = baselines.get(path) ?? [];
    const rel = relativeTo(options.workspace, path);

    const span = options.spans?.get(path);
    const inSpan = span
      ? after.find((d) => d.line >= span.first && d.line <= span.last)
      : undefined;
    if (inSpan) {
      return fail(
        "ERROR_IN_BODY",
        `The new code in ${rel} has a type error at line ${inSpan.line}: TS${inSpan.code} ${inSpan.message}. Fix it without changing the signature.`,
      );
    }

    const introduced = after.find((d) => countIn(after, key(d)) > countIn(before, key(d)));
    if (introduced) {
      return fail(
        "NEW_ERROR",
        `Your edit introduced a new error in ${rel} at line ${introduced.line}: TS${introduced.code} ${introduced.message}. Fix it without adding new errors.`,
      );
    }
  }
  return { layer: "verify", pass: true, ms: Math.round(performance.now() - t0) };
}
