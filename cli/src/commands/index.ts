import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export interface IndexOptions {
  rebuild: boolean;
  status: boolean;
}

export type IndexReport =
  | {
      status: "ok";
      action: "index";
      dbPath: string;
      rebuilt: boolean;
      summary: { filesScanned: number; filesChanged: number; filesRemoved: number; ms: number };
      warnings: string[];
    }
  | {
      status: "ok";
      action: "status";
      dbPath: string;
      exists: boolean;
      files: number;
      symbols: number;
      chunks: number;
      edges: number;
    }
  | { status: "error"; code: string; message: string };

/** Parses the flags after `index`. Unknown flags are rejected. */
export function parseIndexArgs(argv: readonly string[]): IndexOptions | string {
  const options: IndexOptions = { rebuild: false, status: false };
  for (const arg of argv) {
    if (arg === "--rebuild") options.rebuild = true;
    else if (arg === "--status") options.status = true;
    else return `unknown argument for fcx index: ${arg}`;
  }
  if (options.rebuild && options.status) {
    return "--status cannot be combined with --rebuild";
  }
  return options;
}

/** Deletes the index database and its WAL and shared-memory sidecars. Missing files are fine. */
export function removeIndexFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    rmSync(path, { force: true });
  }
}

/**
 * Builds or reports the code index for one workspace. `--status` never creates the database, so it
 * reports zero counts when nothing has been indexed yet.
 */
export async function runIndex(
  options: IndexOptions,
  workspace: string,
  dbPath: string,
  exclude: readonly string[],
): Promise<IndexReport> {
  if (options.status) {
    if (!existsSync(dbPath)) {
      return {
        status: "ok",
        action: "status",
        dbPath,
        exists: false,
        files: 0,
        symbols: 0,
        chunks: 0,
        edges: 0,
      };
    }
    const { openIndex } = await import("@fcx/index");
    const store = openIndex(dbPath);
    try {
      return {
        status: "ok",
        action: "status",
        dbPath,
        exists: true,
        files: store.fileCount(),
        symbols: store.symbolCount(),
        chunks: store.chunkCount(),
        edges: store.edgeCount(),
      };
    } finally {
      store.close();
    }
  }

  if (options.rebuild) removeIndexFiles(dbPath);
  // The index package does not create its parent directory, so a first run in a fresh cache needs it.
  mkdirSync(dirname(dbPath), { recursive: true });
  const { indexWorkspace } = await import("@fcx/index");
  const summary = await indexWorkspace(workspace, { dbPath, exclude: [...exclude] });
  return {
    status: "ok",
    action: "index",
    dbPath,
    rebuilt: options.rebuild,
    summary: {
      filesScanned: summary.filesScanned,
      filesChanged: summary.filesChanged,
      filesRemoved: summary.filesRemoved,
      ms: summary.ms,
    },
    warnings: [...summary.warnings],
  };
}

export function formatIndex(report: IndexReport): string {
  if (report.status === "error") return `fcx index: ${report.message}`;
  if (report.action === "status") {
    if (!report.exists) return `index not built yet (${report.dbPath})`;
    return [
      `index:    ${report.dbPath}`,
      `files:    ${report.files}`,
      `symbols:  ${report.symbols}`,
      `chunks:   ${report.chunks}`,
      `edges:    ${report.edges}`,
    ].join("\n");
  }
  const lines = [
    `${report.rebuilt ? "rebuilt" : "indexed"} ${report.dbPath}`,
    `  scanned ${report.summary.filesScanned}, changed ${report.summary.filesChanged}, removed ${report.summary.filesRemoved}, ${report.summary.ms} ms`,
  ];
  for (const warning of report.warnings) lines.push(`  warning: ${warning}`);
  return lines.join("\n");
}
