import type { LayerName, LayerOutcome } from "./types.js";

export const MAX_FEEDBACK_LINES = 20;

export function trimFeedback(text: string): string {
  return text.split("\n").slice(0, MAX_FEEDBACK_LINES).join("\n");
}

export function timed<T>(fn: () => T): [T, number] {
  const t0 = performance.now();
  const value = fn();
  return [value, Math.round(performance.now() - t0)];
}

export function fail(layer: LayerName, reasonCode: string, feedback: string, ms = 0): LayerOutcome {
  return { layer, pass: false, ms, reasonCode, feedback: trimFeedback(feedback) };
}

export function relativeName(workspace: string, file: string): string {
  return file.startsWith(`${workspace}/`) ? file.slice(workspace.length + 1) : file;
}
