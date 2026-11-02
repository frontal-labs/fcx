import { extname, isAbsolute } from "node:path";
import { type ExitState, LspClient } from "./client.js";
import { LspError } from "./errors.js";
import { readDiskText, runOverlayCheck } from "./overlay.js";
import { detectServers, languageForFile } from "./servers.js";
import type {
  DefinitionOutcome,
  DetectedServer,
  DiagnosticsOutcome,
  Language,
  LanguageServerPoolOptions,
  RenameOutcome,
  ServerCommand,
  ServerExitInfo,
  UnavailableReason,
} from "./types.js";

const DEFAULTS = {
  diagnosticsTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  initializeTimeoutMs: 60_000,
  settleMs: 150,
  maxRestarts: 1,
} as const;

interface Entry {
  readonly language: Language;
  /** Set when a server is usable. Undefined means the language is unavailable. */
  readonly command: ServerCommand | undefined;
  /** Why the language is unavailable, or undefined while it is usable. */
  disabledReason: string | undefined;
  client: LspClient | undefined;
  starting: Promise<LspClient | UnavailableReason> | undefined;
  /** Restarts already spent after unexpected exits. */
  restarts: number;
  /** Unexpected exits seen so far. */
  crashes: number;
}

/**
 * One language server per (workspace, language), started lazily and kept warm.
 *
 * The pool never writes to disk and never applies edits. `rename` returns the
 * WorkspaceEdit for the caller to apply. Unavailable languages return
 * `source: "unavailable"` results instead of throwing, so the caller can fall back.
 *
 * Coordinates are 1-based (line, column). Columns count UTF-16 code units, as LSP does.
 */
export class LanguageServerPool {
  readonly workspace: string;

  private readonly options: LanguageServerPoolOptions;
  private readonly detected: Promise<readonly DetectedServer[]>;
  private readonly entries: Promise<ReadonlyMap<Language, Entry>>;
  private closed = false;
  private closing = false;

  constructor(workspace: string, options: LanguageServerPoolOptions = {}) {
    if (!isAbsolute(workspace)) {
      throw new LspError("INVALID_ARGUMENT", `workspace must be an absolute path: ${workspace}`);
    }
    this.workspace = workspace;
    this.options = options;
    this.detected = detectServers(workspace, options.detect);
    this.entries = this.detected.then((list) => {
      const map = new Map<Language, Entry>();
      for (const item of list) {
        const override = options.servers?.[item.language];
        const command: ServerCommand | undefined =
          override ?? (item.available ? item.command : undefined);
        map.set(item.language, {
          language: item.language,
          command,
          disabledReason:
            command === undefined
              ? item.available
                ? "no server command"
                : item.reason
              : undefined,
          client: undefined,
          starting: undefined,
          restarts: 0,
          crashes: 0,
        });
      }
      return map;
    });
  }

  /** Detection result for every language, as found in the workspace, repo and PATH. */
  servers(): Promise<readonly DetectedServer[]> {
    return this.detected;
  }

  /**
   * Check candidate texts in memory. `overlays` maps absolute paths to candidate text; all
   * files must share the language of `file`. Returns diagnostics for every overlaid file and
   * for `file`. Nothing is written to disk.
   */
  async diagnostics(
    file: string,
    overlays: ReadonlyMap<string, string> = new Map<string, string>(),
  ): Promise<DiagnosticsOutcome> {
    this.requireAbsolute(file);
    const language = languageForFile(file);
    if (language === undefined) return unavailable(null, noLanguageReason(file));
    for (const path of overlays.keys()) {
      this.requireAbsolute(path);
      if (languageForFile(path) !== language) {
        throw new LspError(
          "INVALID_ARGUMENT",
          `overlay ${path} is not ${language}; all overlays must share the language of ${file}`,
          { language },
        );
      }
    }

    const outcome = await this.clientFor(language);
    if (!(outcome instanceof LspClient)) return outcome;
    const timing = {
      timeoutMs: this.options.diagnosticsTimeoutMs ?? DEFAULTS.diagnosticsTimeoutMs,
      settleMs: this.options.settleMs ?? DEFAULTS.settleMs,
    };
    const diagnostics = await outcome.exclusive(() =>
      runOverlayCheck(outcome, file, overlays, timing),
    );
    return { source: "language-server", language, diagnostics };
  }

  /** Definitions of the symbol at a position. Lines and columns are 1-based. */
  async definition(file: string, line: number, column: number): Promise<DefinitionOutcome> {
    this.requireAbsolute(file);
    requirePosition(line, column);
    const language = languageForFile(file);
    if (language === undefined) return unavailable(null, noLanguageReason(file));
    const outcome = await this.clientFor(language);
    if (!(outcome instanceof LspClient)) return outcome;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const locations = await outcome.exclusive(async () => {
      await this.syncToDisk(outcome, file);
      return outcome.definition(file, { line, column }, timeoutMs);
    });
    return { source: "language-server", language, locations };
  }

  /**
   * The WorkspaceEdit that renames the symbol at a position. The caller applies it.
   * This method never writes files.
   */
  async rename(
    file: string,
    line: number,
    column: number,
    newName: string,
  ): Promise<RenameOutcome> {
    this.requireAbsolute(file);
    requirePosition(line, column);
    if (newName.trim() === "") {
      throw new LspError("INVALID_ARGUMENT", "newName must not be empty");
    }
    const language = languageForFile(file);
    if (language === undefined) return unavailable(null, noLanguageReason(file));
    const outcome = await this.clientFor(language);
    if (!(outcome instanceof LspClient)) return outcome;
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const edit = await outcome.exclusive(async () => {
      await this.syncToDisk(outcome, file);
      return outcome.rename(file, { line, column }, newName, timeoutMs);
    });
    return { source: "language-server", language, edit };
  }

  /** Shut down every server and wait for each process to exit. Calls after this throw POOL_CLOSED. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    const map = await this.entries;
    const pending = [...map.values()]
      .map((entry) => entry.starting)
      .filter((value): value is Promise<LspClient | UnavailableReason> => value !== undefined);
    await Promise.allSettled(pending);
    await Promise.all(
      [...map.values()].map(async (entry) => {
        const client = entry.client;
        entry.client = undefined;
        if (client !== undefined) await client.shutdown();
      }),
    );
  }

  /** Make the server hold the disk text of `file` before a position query. */
  private async syncToDisk(client: LspClient, file: string): Promise<void> {
    const text = await readDiskText(file);
    if (text === null) {
      throw new LspError("INVALID_ARGUMENT", `file does not exist: ${file}`, {
        language: client.language,
      });
    }
    client.syncText(file, text);
  }

  /** The running client for a language, starting or restarting it when allowed. */
  private async clientFor(language: Language): Promise<LspClient | UnavailableReason> {
    if (this.closed) throw closedError();
    const entry = (await this.entries).get(language);
    if (entry === undefined) return unavailable(language, "language is not supported");
    if (entry.client !== undefined && !entry.client.alive) this.recordExit(entry, entry.client);
    if (entry.client !== undefined) return entry.client;
    if (entry.starting !== undefined) return entry.starting;
    if (entry.command === undefined || entry.disabledReason !== undefined) {
      return unavailable(language, entry.disabledReason ?? "no server command");
    }

    const maxRestarts = this.options.maxRestarts ?? DEFAULTS.maxRestarts;
    if (entry.crashes > 0) {
      if (entry.restarts >= maxRestarts) {
        throw new LspError(
          "CRASHED",
          `${language} language server crashed ${entry.crashes} time(s) and the restart limit (${maxRestarts}) is used up; not restarting`,
          { language },
        );
      }
      entry.restarts += 1;
    }

    const command = entry.command;
    entry.starting = this.start(entry, command).finally(() => {
      entry.starting = undefined;
    });
    return entry.starting;
  }

  private async start(
    entry: Entry,
    command: ServerCommand,
  ): Promise<LspClient | UnavailableReason> {
    try {
      const client = await LspClient.start({
        language: entry.language,
        command,
        rootPath: this.workspace,
        initializeTimeoutMs: this.options.initializeTimeoutMs ?? DEFAULTS.initializeTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      });
      entry.client = client;
      void client.exited.then(() => this.recordExit(entry, client));
      if (this.closed) {
        entry.client = undefined;
        await client.shutdown();
        throw closedError();
      }
      return client;
    } catch (error) {
      if (error instanceof LspError && error.code === "POOL_CLOSED") throw error;
      if (error instanceof LspError && error.code === "START_FAILED") {
        // Do not retry a server that could not start: report it as unavailable.
        entry.disabledReason = error.message;
        return unavailable(entry.language, error.message);
      }
      throw error;
    }
  }

  /** Record an unexpected exit once. Clean shutdowns are not crashes. */
  private recordExit(entry: Entry, client: LspClient): void {
    if (entry.client !== client) return;
    entry.client = undefined;
    if (this.closing) return;
    entry.crashes += 1;
    const info: ExitState | undefined = client.exitInfo;
    const willRestart = entry.restarts < (this.options.maxRestarts ?? DEFAULTS.maxRestarts);
    const report: ServerExitInfo = {
      language: entry.language,
      code: info?.code ?? null,
      signal: info?.signal ?? null,
      stderrTail: info?.stderrTail ?? "",
      willRestart,
    };
    try {
      this.options.onServerExit?.(report);
    } catch {
      // A failing observer must not break the pool.
    }
  }

  private requireAbsolute(file: string): void {
    if (!isAbsolute(file)) {
      throw new LspError("INVALID_ARGUMENT", `path must be absolute: ${file}`);
    }
  }
}

function unavailable(language: Language | null, reason: string): UnavailableReason {
  return { source: "unavailable", language, reason };
}

function noLanguageReason(file: string): string {
  const ext = extname(file);
  return `no language server handles ${ext === "" ? "files without an extension" : `${ext} files`}`;
}

function requirePosition(line: number, column: number): void {
  if (!Number.isInteger(line) || line < 1 || !Number.isInteger(column) || column < 1) {
    throw new LspError(
      "INVALID_ARGUMENT",
      `line and column must be integers >= 1, got ${line}:${column}`,
    );
  }
}

function closedError(): LspError {
  return new LspError("POOL_CLOSED", "the language server pool has been shut down");
}
