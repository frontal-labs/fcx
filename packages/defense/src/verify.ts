import type { Checker, Diagnostic } from "@fcx/verify";
import type { Bundle, LayerOutcome } from "./types.js";
import { fail, relativeName, timed } from "./util.js";

/**
 * Layer 3: type-check the candidate text with the language service, in memory.
 * The original diagnostic must be gone, and no new error may appear.
 */
export function verify(options: {
  checker: Checker;
  file: string;
  workspace: string;
  candidateText: string;
  target: Diagnostic;
  originalErrors: readonly Diagnostic[];
}): LayerOutcome {
  const [outcome, ms] = timed(() => {
    const overrides = new Map([[options.file, options.candidateText]]);
    const after = options.checker
      .diagnostics(options.file, overrides)
      .filter((d) => d.category === "error");
    const rel = relativeName(options.workspace, options.file);

    // Count per (code, message), so duplicate errors are handled: fixing one of two identical errors is
    // progress. The target counts as fixed only when its count goes down.
    const key = (d: Diagnostic) => `${d.code}:${d.message}`;
    const countIn = (list: readonly Diagnostic[], k: string) =>
      list.filter((d) => key(d) === k).length;
    const targetKey = key(options.target);
    if (countIn(after, targetKey) >= countIn(options.originalErrors, targetKey)) {
      const stillThere = after.find((d) => key(d) === targetKey);
      return fail(
        "verify",
        "TARGET_NOT_FIXED",
        `The original error is still present${stillThere ? ` at line ${stillThere.line}` : ""}: TS${options.target.code} ${options.target.message}`,
      );
    }
    const introduced = after.find(
      (d) => countIn(after, key(d)) > countIn(options.originalErrors, key(d)),
    );
    if (introduced) {
      return fail(
        "verify",
        "NEW_ERROR",
        `Your edit introduced a new error in ${rel} at line ${introduced.line}: TS${introduced.code} ${introduced.message}. Fix only the reported error without adding new ones.`,
      );
    }
    return { layer: "verify" as const, pass: true as const };
  });
  return { ...outcome, ms };
}
