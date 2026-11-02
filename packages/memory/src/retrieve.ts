import type * as Sqlite from "node:sqlite";
import { MemoryError } from "./errors";
import { rowToRecord } from "./records";
import { approximateTokens } from "./tokens";
import type { MemoryKind, MemoryRecord, NeighborhoodResult } from "./types";

export const DEFAULT_BUDGET_TOKENS = 300;

const KIND_PRIORITY: Record<MemoryKind, number> = {
  convention: 0,
  accepted_fix: 1,
  rejected: 2,
};

/** One line per record, as it would appear in a prompt. Tokens are counted on these lines. */
export function formatRecordLine(record: MemoryRecord): string {
  const location = [record.filePath, record.symbol].filter((part) => part !== null && part !== "");
  const suffix = location.length > 0 ? ` (${location.join(" ")})` : "";
  return `- [${record.kind}] ${record.text}${suffix}`;
}

/** A convention's filePath is the directory scope of its AGENTS.md ("" for the root). */
function conventionApplies(record: MemoryRecord, files: readonly string[]): boolean {
  const scope = record.filePath ?? "";
  return files.some((file) => file.startsWith(scope));
}

export function selectNeighborhood(
  db: Sqlite.DatabaseSync,
  files: readonly string[],
  symbols: readonly string[],
  budgetTokens: number,
): NeighborhoodResult {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 0) {
    throw new MemoryError("invalid_budget", "token budget must be a non-negative integer");
  }
  if (files.length === 0 && symbols.length === 0) {
    return { records: [], tokens: 0 };
  }

  const conditions = ["kind = 'convention'"];
  const params: Sqlite.SQLInputValue[] = [];
  if (files.length > 0) {
    conditions.push(`file_path IN (${files.map(() => "?").join(", ")})`);
    params.push(...files);
  }
  if (symbols.length > 0) {
    conditions.push(`symbol IN (${symbols.map(() => "?").join(", ")})`);
    params.push(...symbols);
  }
  const rows = db.prepare(`SELECT * FROM memory WHERE ${conditions.join(" OR ")}`).all(...params);

  const candidates = rows
    .map(rowToRecord)
    .filter((record) =>
      record.kind === "convention"
        ? conventionApplies(record, files)
        : (record.filePath !== null && files.includes(record.filePath)) ||
          (record.symbol !== null && symbols.includes(record.symbol)),
    )
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.createdAt - a.createdAt || b.id - a.id,
    );

  // Records are taken in priority order and the first one that would exceed the budget stops
  // the selection, so a lower-priority record never displaces a higher-priority one.
  const records: MemoryRecord[] = [];
  const lines: string[] = [];
  for (const record of candidates) {
    const line = formatRecordLine(record);
    if (approximateTokens([...lines, line].join("\n")) > budgetTokens) {
      break;
    }
    lines.push(line);
    records.push(record);
  }
  return { records, tokens: approximateTokens(lines.join("\n")) };
}
