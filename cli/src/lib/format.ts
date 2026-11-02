import type { FixReport } from "../commands/fix.js";

/** Human-readable summary of a fix result. */
export function formatFix(report: FixReport): string {
  const head =
    `fcx fix ${report.file ?? ""}${report.diagnostic ? `:${report.diagnostic.line}` : ""}`.trim();
  const lines = [`${head}: ${report.status}`];
  if (report.diagnostic) {
    lines.push(`  error: TS${report.diagnostic.code} ${report.diagnostic.message}`);
  }
  if (report.status === "abstained" || report.status === "escalation-declined") {
    lines.push(`  not verified; not applied. last check: ${report.lastError ?? "unknown"}`);
  }
  if (report.status === "applied" && report.undoId) {
    lines.push(`  applied. undo with: fcx undo (id ${report.undoId})`);
  }
  if (report.status === "verified-escalated") {
    const provider = report.escalation?.provider ?? "hosted";
    lines.push(
      report.applied
        ? `  verified by ${provider} escalation and applied. undo with: fcx undo (id ${report.undoId ?? ""})`
        : `  verified by ${provider} escalation; proposal only, not applied`,
    );
  }
  if (report.escalation && report.escalation.status !== "verified") {
    const detail = report.escalation.message ? `: ${report.escalation.message}` : "";
    lines.push(`  escalation ${report.escalation.status}${detail}`);
  }
  if (report.error) {
    lines.push(`  ${report.error.code}: ${report.error.message}`);
    if (report.error.hint) lines.push(`  hint: ${report.error.hint}`);
  }
  if (
    report.edits &&
    (report.status === "proposed" ||
      report.status === "abstained" ||
      report.status === "declined" ||
      report.status === "escalation-declined" ||
      report.status === "verified-escalated")
  ) {
    for (const edit of report.edits) {
      lines.push(
        `  --- ${edit.file}\n  - ${edit.search.split("\n").join("\n  - ")}\n  + ${edit.replace.split("\n").join("\n  + ")}`,
      );
    }
  }
  lines.push(`  candidates: ${report.candidates.length}, time ${report.timings.totalMs} ms`);
  for (const warning of report.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines.join("\n");
}
