import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { type DiscoveredFile, discoverFiles } from "./discover.js";
import {
  type CallRecord,
  type ExtractionResult,
  type ImportRecord,
  extractFile,
  languageOf,
} from "./extract.js";
import { type FileExtraction, NO_SYMBOLS } from "./extractors/common.js";
import {
  type GoExtractorState,
  defaultGoCacheDir,
  ensureGoExtractor,
  extractGo,
} from "./extractors/go.js";
import { extractPython } from "./extractors/python.js";
import {
  GoModuleCache,
  resolveGoImport,
  resolvePythonImport,
  resolveRustImport,
} from "./extractors/resolve.js";
import { extractRust } from "./extractors/rust.js";
import { coChangePairs, gitCommitFileSets, gitTopLevel } from "./git.js";
import { ModuleResolver } from "./resolve.js";
import { type IndexStore, openIndex } from "./store.js";
import type {
  Embedder,
  FileRecord,
  IndexSummary,
  IndexWorkspaceOptions,
  SymbolRecord,
} from "./types.js";

/** Files above this size keep a row but are not parsed. */
const MAX_PARSE_BYTES = 1_000_000;

/** Languages whose files are parsed for symbols and imports. */
const PARSEABLE_LANGS: ReadonlySet<string> = new Set(["ts", "js", "py", "go", "rs"]);

/** Chunks sent to the embedder per call (plan section 8.2). */
const EMBED_BATCH = 32;

const LANG_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".json", "json"],
  [".md", "md"],
  [".py", "py"],
  [".go", "go"],
  [".rs", "rs"],
]);

function langFor(relPath: string): string | null {
  const known = languageOf(relPath);
  if (known !== undefined) {
    return known;
  }
  return LANG_BY_EXTENSION.get(extname(relPath)) ?? null;
}

interface ScannedFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly lang: string | null;
  readonly hash: string;
  readonly size: number;
  readonly mtime: number;
  readonly text: string | undefined;
}

interface ChangedFile {
  readonly fileId: number;
  readonly path: string;
  readonly lang: string | null;
  readonly absolutePath: string;
  readonly extraction: ExtractionResult;
  readonly symbolIds: readonly number[];
}

async function scan(file: DiscoveredFile): Promise<ScannedFile> {
  const lang = langFor(file.path);
  const bytes = await readFile(file.absolutePath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const parseable =
    lang !== null && PARSEABLE_LANGS.has(lang) && bytes.byteLength <= MAX_PARSE_BYTES;
  return {
    path: file.path,
    absolutePath: file.absolutePath,
    lang,
    hash,
    size: bytes.byteLength,
    mtime: Math.floor(file.mtimeMs),
    text: parseable ? bytes.toString("utf8") : undefined,
  };
}

const EMPTY_EXTRACTION: ExtractionResult = NO_SYMBOLS;

/** Per-run state for toolchains: the Go extractor is built at most once per index run. */
interface RunState {
  readonly goCacheDir: string;
  go?: Promise<GoExtractorState>;
  /** Files skipped because a toolchain is missing, keyed by tool name. */
  readonly missing: Map<string, { reason: string; count: number }>;
}

async function extractByLanguage(file: ScannedFile, run: RunState): Promise<FileExtraction> {
  const text = file.text ?? "";
  switch (file.lang) {
    case "ts":
    case "js":
      return { result: extractFile(file.path, text) };
    case "py":
      return extractPython(file.path, file.absolutePath, text);
    case "go": {
      run.go ??= ensureGoExtractor(run.goCacheDir);
      const state = await run.go;
      if (!state.ok) {
        return { result: EMPTY_EXTRACTION, warning: state.reason, missingTool: "go" };
      }
      return extractGo(state.path, file.path, file.absolutePath, text);
    }
    case "rs":
      return extractRust(text);
    default:
      return { result: EMPTY_EXTRACTION };
  }
}

/** Extracts one changed file. Problems become warnings; a missing toolchain is counted per run. */
async function extractScanned(
  file: ScannedFile,
  run: RunState,
  warnings: string[],
): Promise<ExtractionResult> {
  if (file.text === undefined) {
    return EMPTY_EXTRACTION;
  }
  const outcome = await extractByLanguage(file, run);
  if (outcome.missingTool !== undefined) {
    const entry = run.missing.get(outcome.missingTool);
    run.missing.set(outcome.missingTool, {
      reason: entry?.reason ?? outcome.warning ?? outcome.missingTool,
      count: (entry?.count ?? 0) + 1,
    });
    return EMPTY_EXTRACTION;
  }
  if (outcome.warning !== undefined) {
    warnings.push(outcome.warning);
  }
  return outcome.result;
}

/** Test cases are not call targets. Everything else can be. */
function isCallTarget(symbol: SymbolRecord): boolean {
  return symbol.kind !== "test";
}

/**
 * Finds the symbol a call site refers to. Resolution order: `this.m()` to a method of the
 * caller's class, `ns.f()` to a namespace import, a local top-level name, then a named import.
 * Unresolved names produce no edge.
 */
function resolveCallee(
  store: IndexStore,
  fileId: number,
  caller: SymbolRecord,
  call: CallRecord,
  importsByLocal: ReadonlyMap<string, { target: number | undefined; imported: string }>,
  namespaceTargets: ReadonlyMap<string, number | undefined>,
): number | undefined {
  const pick = (candidates: readonly SymbolRecord[]): number | undefined =>
    candidates.find(isCallTarget)?.id;
  if (call.receiver?.kind === "this") {
    const dot = caller.qualified.indexOf(".");
    if (dot < 0) {
      return undefined;
    }
    const owner = caller.qualified.slice(0, dot);
    return pick(store.symbolsByQualified(fileId, `${owner}.${call.name}`));
  }
  if (call.receiver?.kind === "identifier") {
    const target = namespaceTargets.get(call.receiver.name);
    if (target === undefined) {
      return undefined;
    }
    return pick(store.symbolsByQualified(target, call.name));
  }
  const local = store
    .symbolsByQualified(fileId, call.name)
    .filter((s) => !s.qualified.includes("."));
  const localId = pick(local);
  if (localId !== undefined) {
    return localId;
  }
  const binding = importsByLocal.get(call.name);
  if (binding?.target === undefined) {
    return undefined;
  }
  return pick(store.symbolsByQualified(binding.target, binding.imported));
}

/**
 * Indexes a workspace into the SQLite database at `options.dbPath`. Unchanged files (same
 * content hash) are skipped. Deleted files are removed with their rows. Co-change edges are
 * rebuilt when the workspace is a git repository. Embeddings run only when `options.embedder`
 * is set, and an embedding failure is reported in `warnings` without failing the index.
 */
export async function indexWorkspace(
  root: string,
  options: IndexWorkspaceOptions,
): Promise<IndexSummary> {
  const started = performance.now();
  const warnings: string[] = [];
  const absoluteRoot = await realpath(resolve(root));
  const store = openIndex(options.dbPath);
  try {
    const { files: found } = await discoverFiles(absoluteRoot, options.exclude ?? []);
    // The database lives in the workspace in some setups. Never index it or its SQLite sidecars.
    const databasePath = join(
      await realpath(dirname(resolve(options.dbPath))),
      basename(options.dbPath),
    );
    const discovered = found.filter(
      (file) => !isDatabaseFile(resolve(absoluteRoot, file.path), databasePath),
    );
    const scanned: ScannedFile[] = [];
    for (const file of discovered) {
      scanned.push(await scan(file));
    }
    const discoveredPaths = new Set(scanned.map((file) => file.path));
    const existing = new Map<string, FileRecord>(
      store.listFiles().map((file) => [file.path, file]),
    );
    const changed = scanned.filter((file) => existing.get(file.path)?.hash !== file.hash);
    const removed = [...existing.values()].filter((file) => !discoveredPaths.has(file.path));

    // Extraction runs outside the transaction: the Python, Go and Rust paths are asynchronous.
    const run: RunState = {
      goCacheDir: options.goCacheDir ?? defaultGoCacheDir(),
      missing: new Map(),
    };
    const extractions = new Map<string, ExtractionResult>();
    for (const file of changed) {
      extractions.set(file.path, await extractScanned(file, run, warnings));
    }
    for (const [tool, entry] of run.missing) {
      warnings.push(`${entry.reason}; ${entry.count} ${tool} file(s) were not indexed`);
    }

    store.transaction(() => {
      for (const file of removed) {
        store.removeFile(file.id);
      }
      const changedFiles: ChangedFile[] = [];
      for (const file of changed) {
        const fileId = store.upsertFile({
          path: file.path,
          lang: file.lang,
          hash: file.hash,
          mtime: file.mtime,
          size: file.size,
        });
        const extraction = extractions.get(file.path) ?? EMPTY_EXTRACTION;
        const symbolIds = store.replaceSymbols(fileId, extraction.symbols);
        store.clearOutgoingEdges(fileId);
        changedFiles.push({
          fileId,
          path: file.path,
          lang: file.lang,
          absolutePath: file.absolutePath,
          extraction,
          symbolIds,
        });
      }
      writeEdges(store, absoluteRoot, changedFiles);
    });

    await refreshCoChange(store, absoluteRoot, warnings);
    if (options.embedder !== undefined) {
      await refreshVectors(store, options.embedder, warnings);
    }
    store.setMeta("built_at", new Date().toISOString());

    return {
      filesScanned: scanned.length,
      filesChanged: changed.length,
      filesRemoved: removed.length,
      ms: Math.round(performance.now() - started),
      warnings,
    };
  } finally {
    store.close();
  }
}

/**
 * Absolute paths of the workspace files an import specifier refers to, by language. Empty when
 * the import is external or cannot be resolved.
 */
function resolveImportPaths(
  lang: string | null,
  absoluteRoot: string,
  importer: string,
  specifier: string,
  resolver: ModuleResolver,
  goModules: GoModuleCache,
): string[] {
  switch (lang) {
    case "ts":
    case "js": {
      const resolved = resolver.resolve(importer, specifier);
      return resolved === undefined ? [] : [resolved];
    }
    case "py":
      return resolvePythonImport(absoluteRoot, importer, specifier);
    case "go":
      return resolveGoImport(absoluteRoot, importer, specifier, goModules);
    case "rs":
      return resolveRustImport(absoluteRoot, importer, specifier);
    default:
      return [];
  }
}

function writeEdges(
  store: IndexStore,
  absoluteRoot: string,
  changedFiles: readonly ChangedFile[],
): void {
  const resolver = new ModuleResolver(absoluteRoot);
  const goModules = new GoModuleCache(absoluteRoot);
  const idByPath = new Map<string, number>(store.listFiles().map((file) => [file.path, file.id]));
  const toFileId = (absolutePath: string): number | undefined => {
    const rel = relative(absoluteRoot, absolutePath).split(sep).join("/");
    return idByPath.get(rel);
  };
  for (const changedFile of changedFiles) {
    const { extraction, fileId, symbolIds } = changedFile;
    const importTargets = new Map<ImportRecord, number | undefined>();
    for (const imp of extraction.imports) {
      const targets = new Set<number>();
      for (const path of resolveImportPaths(
        changedFile.lang,
        absoluteRoot,
        changedFile.absolutePath,
        imp.specifier,
        resolver,
        goModules,
      )) {
        const target = toFileId(path);
        if (target !== undefined && target !== fileId) {
          targets.add(target);
        }
      }
      const [first] = targets;
      importTargets.set(imp, first);
      for (const target of targets) {
        store.addEdge({ src: fileId, dst: target, kind: "imports", weight: 1 });
      }
    }
    const importsByLocal = new Map<string, { target: number | undefined; imported: string }>();
    const namespaceTargets = new Map<string, number | undefined>();
    for (const imp of extraction.imports) {
      const target = importTargets.get(imp);
      for (const binding of imp.bindings) {
        if (binding.kind === "named") {
          importsByLocal.set(binding.local, { target, imported: binding.imported });
        } else if (binding.kind === "namespace") {
          namespaceTargets.set(binding.local, target);
        }
      }
    }
    for (const call of extraction.calls) {
      const callerId = symbolIds[call.caller];
      const caller = callerId === undefined ? undefined : store.symbolById(callerId);
      if (caller === undefined) {
        continue;
      }
      const calleeId = resolveCallee(store, fileId, caller, call, importsByLocal, namespaceTargets);
      if (calleeId === undefined || calleeId === caller.id) {
        continue;
      }
      store.addEdge({
        src: caller.id,
        dst: calleeId,
        kind: caller.kind === "test" ? "tests" : "calls",
        weight: 1,
      });
    }
  }
}

async function refreshCoChange(
  store: IndexStore,
  absoluteRoot: string,
  warnings: string[],
): Promise<void> {
  const top = await gitTopLevel(absoluteRoot);
  if (top === undefined) {
    return;
  }
  const commits = await gitCommitFileSets(absoluteRoot);
  if (commits === undefined) {
    warnings.push("git log failed; co-change edges were not updated");
    return;
  }
  const prefix = relative(top, absoluteRoot).split(sep).join("/");
  const toWorkspacePath = (repoPath: string): string | undefined => {
    if (prefix === "") {
      return repoPath;
    }
    return repoPath.startsWith(`${prefix}/`) ? repoPath.slice(prefix.length + 1) : undefined;
  };
  const idByPath = new Map<string, number>(store.listFiles().map((file) => [file.path, file.id]));
  const mapped = commits.map((commit) =>
    commit.map(toWorkspacePath).filter((path): path is string => path !== undefined),
  );
  const pairs = coChangePairs(mapped, new Set(idByPath.keys()));
  store.transaction(() => {
    store.deleteEdgesOfKind("co_changes");
    for (const pair of pairs) {
      const a = idByPath.get(pair.a);
      const b = idByPath.get(pair.b);
      if (a === undefined || b === undefined) {
        continue;
      }
      store.addEdge({ src: a, dst: b, kind: "co_changes", weight: pair.weight });
      store.addEdge({ src: b, dst: a, kind: "co_changes", weight: pair.weight });
    }
  });
}

async function refreshVectors(
  store: IndexStore,
  embedder: Embedder,
  warnings: string[],
): Promise<void> {
  const model = `${embedder.model}:${embedder.dimensions}`;
  if (store.getMeta("embed_model") !== model) {
    store.clearVectors();
    store.setMeta("embed_model", model);
  }
  for (;;) {
    const batch = store.chunksMissingVectors(EMBED_BATCH);
    if (batch.length === 0) {
      return;
    }
    try {
      const vectors = await embedder.embed(batch.map((chunk) => chunk.text));
      if (vectors.length !== batch.length) {
        warnings.push(`embedder returned ${vectors.length} vectors for ${batch.length} chunks`);
        return;
      }
      store.putVectors(
        batch.map((chunk, i) => {
          const vector = vectors[i];
          if (vector === undefined || vector.length !== embedder.dimensions) {
            throw new Error(`embedding has the wrong dimension for chunk ${chunk.id}`);
          }
          return { chunkId: chunk.id, vector };
        }),
      );
    } catch (error) {
      warnings.push(`embedding failed; vectors were not written: ${String(error)}`);
      return;
    }
  }
}

/** True for the database file itself and its `-wal`, `-shm` and `-journal` sidecars. */
function isDatabaseFile(candidate: string, databasePath: string): boolean {
  return candidate === databasePath || candidate.startsWith(`${databasePath}-`);
}
