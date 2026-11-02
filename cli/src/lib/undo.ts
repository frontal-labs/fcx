import { undoLatest } from "@fcx/apply";
import { undoRootFor } from "./repo.js";

export type UndoOutcome =
  | { status: "ok"; undoId: string; restored: string[] }
  | { status: "error"; message: string };

export function applyUndo(cacheDir: string, workspace: string): UndoOutcome {
  try {
    return { status: "ok", ...undoLatest(undoRootFor(cacheDir, workspace), workspace) };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
