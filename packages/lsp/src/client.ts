import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { ResponseError } from "vscode-jsonrpc/node";
import * as lsp from "vscode-languageserver-protocol";
import {
  fromLspDiagnostic,
  fromLspLocations,
  fromLspWorkspaceEdit,
  toLspPosition,
} from "./convert.js";
import { LspError } from "./errors.js";
import { type ServerProcess, spawnServer } from "./transport.js";
import type {
  Diagnostic,
  Language,
  Location,
  Position,
  ServerCommand,
  WorkspaceEdit,
} from "./types.js";

/** Why and how a server process ended. */
export interface ExitState {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
  readonly spawnError?: string;
}

export interface ClientStartOptions {
  readonly language: Language;
  readonly command: ServerCommand;
  readonly rootPath: string;
  readonly initializeTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface CheckTiming {
  readonly timeoutMs: number;
  readonly settleMs: number;
  readonly emptySettleMs: number;
  readonly silentCleanMs: number;
}

interface DocumentState {
  /** Monotonic for the lifetime of the client, even across close and reopen. */
  version: number;
  open: boolean;
  /** The text the server currently holds. */
  text: string;
  /** Diagnostics from the last publish for this document, if any. */
  lastPublished: lsp.Diagnostic[] | undefined;
}

interface PublishWaiter {
  readonly uri: string;
  readonly minVersion: number;
  readonly settleMs: number;
  readonly emptySettleMs: number;
  readonly resolve: (diagnostics: lsp.Diagnostic[]) => void;
  readonly reject: (error: LspError) => void;
  deadline: NodeJS.Timeout | undefined;
  settleTimer: NodeJS.Timeout | undefined;
  /** Set when the previous state was known to be empty; see `waitForPublish`. */
  latest: lsp.Diagnostic[] | undefined;
}

const SHUTDOWN_TIMEOUT_MS = 1000;
const EXIT_GRACE_MS = 1000;

function languageIdFor(file: string, language: Language): string {
  if (language === "typescript") {
    switch (extname(file).toLowerCase()) {
      case ".tsx":
        return "typescriptreact";
      case ".jsx":
        return "javascriptreact";
      case ".js":
      case ".mjs":
      case ".cjs":
        return "javascript";
      default:
        return "typescript";
    }
  }
  return language;
}

function sleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/**
 * One language server process and its JSON-RPC connection.
 * All document operations go through `exclusive`, so checks never interleave.
 */
export class LspClient {
  readonly language: Language;
  readonly rootPath: string;

  private readonly server: ServerProcess;
  private readonly documents = new Map<string, DocumentState>();
  private readonly waiters = new Set<PublishWaiter>();
  private readonly exitSignal: Promise<ExitState>;
  private exitState: ExitState | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  /** True when the server advertised pull diagnostics, so a check can ask for the result directly. */
  private pullDiagnostics = false;

  private constructor(language: Language, rootPath: string, server: ServerProcess) {
    this.language = language;
    this.rootPath = rootPath;
    this.server = server;
    this.exitSignal = new Promise<ExitState>((resolve) => {
      const finish = (state: ExitState): void => {
        if (this.exitState !== undefined) return;
        this.exitState = state;
        this.onExit();
        resolve(state);
      };
      server.child.once("exit", (code, signal) => {
        finish({ code, signal, stderrTail: server.stderrTail() });
      });
      server.child.once("error", (error) => {
        finish({
          code: null,
          signal: null,
          stderrTail: server.stderrTail(),
          spawnError: error.message,
        });
      });
    });
    server.connection.onNotification(lsp.PublishDiagnosticsNotification.type, (params) => {
      this.onPublish(params);
    });
    this.registerServerRequests();
  }

  /** Spawn the server and complete the initialize handshake. Throws LspError START_FAILED. */
  static async start(options: ClientStartOptions): Promise<LspClient> {
    const server = spawnServer(options.command, options.rootPath);
    const client = new LspClient(options.language, options.rootPath, server);
    server.connection.listen();
    try {
      await client.initialize(options);
    } catch (error) {
      await client.kill();
      const detail = error instanceof Error ? error.message : String(error);
      throw new LspError(
        "START_FAILED",
        `${options.language} language server failed to start: ${detail}`,
        {
          language: options.language,
          cause: error,
        },
      );
    }
    return client;
  }

  get alive(): boolean {
    return this.exitState === undefined;
  }

  /** Resolves once the process has exited, for any reason. */
  get exited(): Promise<ExitState> {
    return this.exitSignal;
  }

  /** How the process ended, once it has. */
  get exitInfo(): ExitState | undefined {
    return this.exitState;
  }

  /** Run one operation at a time on this server. */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Send the full text of a file and wait for diagnostics computed from it.
   * The waiter is registered before the message is sent, so a fast publish is not missed.
   */
  async checkText(file: string, text: string, timing: CheckTiming): Promise<lsp.Diagnostic[]> {
    // Checked first: a waiter created for a dead process would reject with nobody listening.
    if (!this.alive) throw this.crashError();
    const uri = pathToFileURL(file).href;
    const before = this.documents.get(uri);
    const nextVersion = (before?.version ?? 0) + 1;
    if (this.pullDiagnostics) {
      // Pull: the answer comes back explicitly, including "no errors". Silence cannot be misread.
      this.sendFullText(file, text);
      return this.pullDocument(uri, timing);
    }
    const waiting = this.waitForPublish(uri, nextVersion, timing);
    this.sendFullText(file, text);
    return waiting;
  }

  /** Ask the server for the current diagnostics of `uri` (textDocument/diagnostic). */
  private async pullDocument(uri: string, timing: CheckTiming): Promise<lsp.Diagnostic[]> {
    const report = await this.request("textDocument/diagnostic", timing.timeoutMs, () =>
      this.connection().sendRequest(lsp.DocumentDiagnosticRequest.type, {
        textDocument: { uri },
      }),
    );
    if (report.kind !== "full") {
      throw new LspError("PROTOCOL_ERROR", `unexpected diagnostic report kind "${report.kind}"`, {
        language: this.language,
      });
    }
    return report.items;
  }

  /** Make the server hold `text` for `file` without waiting for diagnostics. */
  syncText(file: string, text: string): void {
    const doc = this.documents.get(pathToFileURL(file).href);
    if (doc?.open && doc.text === text) return;
    this.sendFullText(file, text);
  }

  /** Close a document on the server. Its version counter is kept. */
  closeDocument(file: string): void {
    const uri = pathToFileURL(file).href;
    const doc = this.documents.get(uri);
    if (doc === undefined || !doc.open) return;
    doc.open = false;
    this.notify(() =>
      this.connection().sendNotification(lsp.DidCloseTextDocumentNotification.type, {
        textDocument: { uri },
      }),
    );
  }

  async definition(file: string, position: Position, timeoutMs: number): Promise<Location[]> {
    const result = await this.request("textDocument/definition", timeoutMs, () =>
      this.connection().sendRequest(lsp.DefinitionRequest.type, {
        textDocument: { uri: pathToFileURL(file).href },
        position: toLspPosition(position),
      }),
    );
    return fromLspLocations(result);
  }

  async rename(
    file: string,
    position: Position,
    newName: string,
    timeoutMs: number,
  ): Promise<WorkspaceEdit> {
    const result = await this.request("textDocument/rename", timeoutMs, () =>
      this.connection().sendRequest(lsp.RenameRequest.type, {
        textDocument: { uri: pathToFileURL(file).href },
        position: toLspPosition(position),
        newName,
      }),
    );
    return fromLspWorkspaceEdit(result);
  }

  /** Ask the server to exit, then kill it if it does not. Never throws. */
  async shutdown(): Promise<void> {
    if (this.exitState !== undefined) {
      this.server.connection.dispose();
      return;
    }
    try {
      await this.request("shutdown", SHUTDOWN_TIMEOUT_MS, () =>
        this.connection().sendRequest(lsp.ShutdownRequest.type),
      );
    } catch {
      // The exit path below handles a server that does not answer.
    }
    if (this.exitState === undefined) {
      try {
        this.connection().sendNotification(lsp.ExitNotification.type);
      } catch {
        // Already disconnected.
      }
    }
    await this.kill();
  }

  /** Kill the process and wait for the exit event. */
  private async kill(): Promise<void> {
    if (this.exitState === undefined) {
      const grace = sleep(EXIT_GRACE_MS);
      const exitedInTime = await Promise.race([
        this.exitSignal.then(() => true),
        grace.promise.then(() => false),
      ]);
      grace.cancel();
      if (!exitedInTime && this.exitState === undefined) {
        this.server.child.kill("SIGKILL");
      }
      await this.exitSignal;
    }
    this.server.connection.dispose();
  }

  private connection(): ServerProcess["connection"] {
    return this.server.connection;
  }

  private async initialize(options: ClientStartOptions): Promise<void> {
    const rootUri = pathToFileURL(options.rootPath).href;
    const params: lsp.InitializeParams = {
      processId: process.pid,
      clientInfo: { name: "@fcx/lsp" },
      rootUri,
      rootPath: options.rootPath,
      workspaceFolders: [{ uri: rootUri, name: basename(options.rootPath) }],
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          definition: { linkSupport: true },
          rename: { prepareSupport: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
        workspace: {
          workspaceFolders: true,
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"],
          },
        },
      },
      ...(options.command.initializationOptions === undefined
        ? {}
        : { initializationOptions: options.command.initializationOptions }),
    };
    const result = await this.request("initialize", options.initializeTimeoutMs, () =>
      this.connection().sendRequest(lsp.InitializeRequest.type, params),
    );
    this.pullDiagnostics = result.capabilities.diagnosticProvider !== undefined;
    this.notify(() => this.connection().sendNotification(lsp.InitializedNotification.type, {}));
  }

  /** Answer the server-to-client requests that servers send during normal operation. */
  private registerServerRequests(): void {
    const connection = this.server.connection;
    connection.onRequest("workspace/configuration", (params: lsp.ConfigurationParams) =>
      params.items.map(() => null),
    );
    connection.onRequest("workspace/workspaceFolders", () => [
      { uri: pathToFileURL(this.rootPath).href, name: basename(this.rootPath) },
    ]);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("window/showMessageRequest", () => null);
    connection.onRequest("workspace/applyEdit", () => ({ applied: false }));
  }

  private sendFullText(file: string, text: string): void {
    const uri = pathToFileURL(file).href;
    let doc = this.documents.get(uri);
    if (doc === undefined) {
      doc = { version: 0, open: false, text: "", lastPublished: undefined };
      this.documents.set(uri, doc);
    }
    doc.version += 1;
    doc.text = text;
    if (doc.open) {
      const version = doc.version;
      this.notify(() =>
        this.connection().sendNotification(lsp.DidChangeTextDocumentNotification.type, {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        }),
      );
    } else {
      doc.open = true;
      const version = doc.version;
      const languageId = languageIdFor(file, this.language);
      this.notify(() =>
        this.connection().sendNotification(lsp.DidOpenTextDocumentNotification.type, {
          textDocument: { uri, languageId, version, text },
        }),
      );
    }
  }

  private notify(send: () => void): void {
    if (!this.alive) throw this.crashError();
    send();
  }

  /**
   * Resolve with the diagnostics published for `uri` at or after `minVersion`.
   * Publishes are collected until `settleMs` passes with no further publish. If the server
   * never publishes, the wait fails with TIMEOUT. Silence is never read as "no errors": some
   * servers stay silent when a file is clean, so that case is reported as unknown, not clean.
   */
  private waitForPublish(
    uri: string,
    minVersion: number,
    timing: CheckTiming,
  ): Promise<lsp.Diagnostic[]> {
    return new Promise<lsp.Diagnostic[]>((resolve, reject) => {
      if (!this.alive) {
        reject(this.crashError());
        return;
      }
      // The state before this check. If it was empty, a server may stay silent when the new text is clean too.
      const previous = this.documents.get(uri)?.lastPublished;
      const silentlyClean = previous !== undefined && previous.length === 0;
      const waiter: PublishWaiter = {
        uri,
        minVersion,
        settleMs: timing.settleMs,
        emptySettleMs: timing.emptySettleMs,
        resolve,
        reject,
        deadline: undefined,
        settleTimer: undefined,
        latest: undefined,
      };
      waiter.deadline = setTimeout(
        () => {
          this.removeWaiter(waiter);
          if (silentlyClean) {
            resolve([]);
            return;
          }
          reject(
            new LspError(
              "TIMEOUT",
              `${this.language} language server sent no diagnostics for ${uri} within ${timing.timeoutMs} ms`,
              { language: this.language },
            ),
          );
        },
        silentlyClean ? timing.silentCleanMs : timing.timeoutMs,
      );
      this.waiters.add(waiter);
    });
  }

  private removeWaiter(waiter: PublishWaiter): void {
    this.waiters.delete(waiter);
    if (waiter.deadline !== undefined) clearTimeout(waiter.deadline);
    if (waiter.settleTimer !== undefined) clearTimeout(waiter.settleTimer);
  }

  private onPublish(params: lsp.PublishDiagnosticsParams): void {
    const doc = this.documents.get(params.uri);
    if (doc !== undefined && (params.version === undefined || params.version === doc.version)) {
      doc.lastPublished = params.diagnostics;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.uri !== params.uri) continue;
      if (params.version !== undefined && params.version < waiter.minVersion) continue;
      waiter.latest = params.diagnostics;
      if (waiter.deadline !== undefined) {
        clearTimeout(waiter.deadline);
        waiter.deadline = undefined;
      }
      if (waiter.settleTimer !== undefined) clearTimeout(waiter.settleTimer);
      // An empty publish may be the syntax pass; the type errors can follow it, so it waits longer.
      const quiet = params.diagnostics.length === 0 ? waiter.emptySettleMs : waiter.settleMs;
      waiter.settleTimer = setTimeout(() => {
        this.removeWaiter(waiter);
        waiter.resolve(waiter.latest ?? []);
      }, quiet);
    }
  }

  private onExit(): void {
    for (const waiter of [...this.waiters]) {
      this.removeWaiter(waiter);
      waiter.reject(this.crashError());
    }
  }

  private crashError(): LspError {
    const state = this.exitState;
    const parts: string[] = [];
    if (state?.spawnError !== undefined) {
      parts.push(`spawn error: ${state.spawnError}`);
    } else {
      parts.push(`code ${state?.code ?? "unknown"}, signal ${state?.signal ?? "none"}`);
    }
    const stderr = state?.stderrTail ?? "";
    const tail = stderr === "" ? "" : `; stderr: ${stderr.split("\n").slice(-5).join(" | ")}`;
    return new LspError(
      "CRASHED",
      `${this.language} language server exited unexpectedly (${parts.join(", ")})${tail}`,
      { language: this.language },
    );
  }

  /** Run a request with a timeout, and map failures to LspError. */
  private async request<T>(label: string, timeoutMs: number, send: () => Promise<T>): Promise<T> {
    if (!this.alive) throw this.crashError();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new LspError(
            "TIMEOUT",
            `${this.language} language server did not answer ${label} within ${timeoutMs} ms`,
            { language: this.language },
          ),
        );
      }, timeoutMs);
    });
    const crashed = this.exitSignal.then((): never => {
      throw this.crashError();
    });
    try {
      return await Promise.race([Promise.resolve().then(send), timeout, crashed]);
    } catch (error) {
      throw this.toLspError(label, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private toLspError(label: string, error: unknown): LspError {
    if (error instanceof LspError) return error;
    if (error instanceof ResponseError) {
      return new LspError(
        "PROTOCOL_ERROR",
        `${this.language} language server rejected ${label}: ${error.message} (code ${error.code})`,
        { language: this.language, cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (!this.alive || /closed|disposed/i.test(message)) return this.crashError();
    return new LspError(
      "PROTOCOL_ERROR",
      `${this.language} language server failed ${label}: ${message}`,
      { language: this.language, cause: error },
    );
  }
}

/** Convert raw LSP diagnostics for one file. */
export function toDiagnostics(file: string, raw: readonly lsp.Diagnostic[]): Diagnostic[] {
  return raw.map((item) => fromLspDiagnostic(file, item));
}
