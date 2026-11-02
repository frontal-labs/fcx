import { type Edit, resolveInWorkspace } from "@fcx/apply";
import type { Bundle, LayerOutcome } from "./types.js";
import { fail, relativeName, timed } from "./util.js";

/** Layer 1: every edit targets an allowed file. Paths outside the workspace are rejected. */
export function constrain(edits: readonly Edit[], bundle: Bundle): LayerOutcome {
  const [outcome, ms] = timed(() => {
    for (const edit of edits) {
      let target: string;
      try {
        target = resolveInWorkspace(bundle.workspace, edit.file);
      } catch {
        return fail(
          "constrain",
          "PATH_OUTSIDE_WORKSPACE",
          `File "${edit.file}" is outside the workspace.`,
        );
      }
      if (!bundle.allowedFiles.includes(target)) {
        return fail(
          "constrain",
          "PATH_NOT_ALLOWED",
          `Only these files may be edited: ${bundle.allowedFiles.map((f) => relativeName(bundle.workspace, f)).join(", ")}.`,
        );
      }
    }
    return { layer: "constrain" as const, pass: true as const };
  });
  return { ...outcome, ms };
}
