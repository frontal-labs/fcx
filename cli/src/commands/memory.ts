import { MEMORY_KINDS, type MemoryKind, type MemoryRecord, openMemory } from "@fcx/memory";

export type MemoryAction = "list" | "forget" | "clear";

export type MemoryReport =
  | { status: "ok"; action: "list"; records: MemoryRecord[] }
  | { status: "ok"; action: "forget"; id: number }
  | { status: "ok"; action: "clear"; kind?: MemoryKind; removed: number }
  | { status: "error"; code: string; message: string };

const USAGE = "usage: fcx memory list [--kind K] | forget <id> | clear [--kind K]";

/** Narrows a string to a memory kind, so no cast is needed. */
export function parseKind(value: string): MemoryKind | undefined {
  return MEMORY_KINDS.find((kind) => kind === value);
}

interface ParsedArgs {
  kind?: MemoryKind;
  positional: string[];
}

/** Parses `--kind K` and `--kind=K`. Any other flag is an error, so a typo never widens a clear. */
function parseArgs(args: readonly string[]): ParsedArgs | string {
  const parsed: ParsedArgs = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--kind" || arg.startsWith("--kind=")) {
      const value = arg === "--kind" ? args[++i] : arg.slice("--kind=".length);
      const kind = value === undefined ? undefined : parseKind(value);
      if (kind === undefined) {
        return `--kind must be one of ${MEMORY_KINDS.join(", ")}`;
      }
      parsed.kind = kind;
    } else if (arg.startsWith("-")) {
      return `unknown flag for fcx memory: ${arg}`;
    } else {
      parsed.positional.push(arg);
    }
  }
  return parsed;
}

/**
 * Runs `fcx memory <action>` against the database at memoryPath. argv is the text after `memory`.
 * Nothing leaves the local database.
 */
export function runMemory(argv: readonly string[], memoryPath: string): MemoryReport {
  const [action, ...rest] = argv;
  if (action !== "list" && action !== "forget" && action !== "clear") {
    return { status: "error", code: "USAGE", message: USAGE };
  }
  const parsed = parseArgs(rest);
  if (typeof parsed === "string") {
    return { status: "error", code: "USAGE", message: parsed };
  }

  let store: ReturnType<typeof openMemory>;
  try {
    store = openMemory(memoryPath);
  } catch (error) {
    return { status: "error", code: "MEMORY_UNAVAILABLE", message: messageOf(error) };
  }
  try {
    if (action === "list") {
      if (parsed.positional.length > 0) {
        return { status: "error", code: "USAGE", message: USAGE };
      }
      return {
        status: "ok",
        action,
        records: store.list(parsed.kind === undefined ? {} : { kind: parsed.kind }),
      };
    }
    if (action === "forget") {
      const [raw] = parsed.positional;
      const id = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (parsed.positional.length !== 1 || parsed.kind !== undefined || !Number.isInteger(id)) {
        return { status: "error", code: "USAGE", message: "usage: fcx memory forget <id>" };
      }
      if (!store.forget(id)) {
        return { status: "error", code: "NOT_FOUND", message: `no memory record with id ${id}` };
      }
      return { status: "ok", action, id };
    }
    if (parsed.positional.length > 0) {
      return { status: "error", code: "USAGE", message: USAGE };
    }
    const removed = store.clear(parsed.kind === undefined ? {} : { kind: parsed.kind });
    return parsed.kind === undefined
      ? { status: "ok", action, removed }
      : { status: "ok", action, kind: parsed.kind, removed };
  } finally {
    store.close();
  }
}

/** Human-readable output for a memory report. */
export function formatMemory(report: MemoryReport): string {
  if (report.status === "error") return `fcx memory: ${report.message}`;
  if (report.action === "forget") return `forgot memory record #${report.id}`;
  if (report.action === "clear") {
    const scope = report.kind === undefined ? "" : ` of kind ${report.kind}`;
    return `removed ${report.removed} memory record(s)${scope}`;
  }
  if (report.records.length === 0) return "no memory records";
  return report.records
    .map((r) => {
      const where = r.filePath === null ? "" : ` ${r.filePath}`;
      return `#${r.id} [${r.kind}]${where}: ${r.text}`;
    })
    .join("\n");
}

export function memoryExitCode(report: MemoryReport): number {
  return report.status === "ok" ? 0 : 1;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
