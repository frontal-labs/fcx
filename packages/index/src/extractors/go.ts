/**
 * Go extraction. `main.go` next to this file is built with the local `go` toolchain into a cache
 * directory (argv only, no network, read-only modules) and cached by the sha256 of its source.
 * When `go` is not on PATH, Go files are skipped and the indexer reports one warning per run.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtractionResult, ImportRecord } from "../extract.js";
import type { SymbolInput } from "../types.js";
import {
  type FileExtraction,
  type SymbolDraft,
  makeSymbol,
  runProcess,
  skipped,
} from "./common.js";

const BUILD_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 10_000;
const RUN_MAX_OUTPUT = 32 * 1024 * 1024;

export type GoExtractorState =
  | { readonly ok: true; readonly path: string; readonly built: boolean }
  | { readonly ok: false; readonly reason: string };

/** Default cache location: `$FRONTAL_CODE_CACHE_DIR/go-extract` or `~/.cache/fcx/go-extract`. */
export function defaultGoCacheDir(): string {
  const configured = process.env.FRONTAL_CODE_CACHE_DIR;
  if (configured !== undefined && configured.length > 0) {
    return join(configured, "go-extract");
  }
  return join(homedir(), ".cache", "fcx", "go-extract");
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false,
  );
}

async function sourcePath(): Promise<string | undefined> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Under src/ the source sits beside this file. Under dist/ it is two levels up in src/.
  const candidates = [
    join(here, "go", "main.go"),
    resolve(here, "..", "..", "src", "extractors", "go", "main.go"),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Returns the path of the built extractor, building it when the cache has no binary for the
 * current source. Never throws.
 */
export async function ensureGoExtractor(cacheDir: string): Promise<GoExtractorState> {
  const source = await sourcePath();
  if (source === undefined) {
    return { ok: false, reason: "Go extractor source (extractors/go/main.go) not found" };
  }
  const bytes = await readFile(source);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const exe = process.platform === "win32" ? ".exe" : "";
  const binary = join(cacheDir, `fcx-go-extract-${digest}${exe}`);
  if (await fileExists(binary)) {
    return { ok: true, path: binary, built: false };
  }

  await mkdir(cacheDir, { recursive: true });
  const workDir = await mkdtemp(join(cacheDir, "build-"));
  try {
    const temporary = join(workDir, `extract${exe}`);
    const build = await runProcess("go", ["build", "-o", temporary, source], {
      timeoutMs: BUILD_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      cwd: workDir,
      env: {
        ...process.env,
        GOFLAGS: "-mod=readonly",
        GOPROXY: "off",
        GOTOOLCHAIN: "local",
        CGO_ENABLED: "0",
      },
    });
    if (!build.ok) {
      if (build.spawnCode === "ENOENT") {
        return { ok: false, reason: "go toolchain not found on PATH" };
      }
      return { ok: false, reason: `go build failed: ${build.stderr.trim().slice(0, 500)}` };
    }
    await rename(temporary, binary);
    return { ok: true, path: binary, built: true };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

interface GoSymbol {
  readonly name: string;
  readonly qualified: string;
  readonly kind: SymbolDraft["kind"];
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc: string;
  readonly exported: boolean;
}

const GO_KINDS: ReadonlySet<string> = new Set([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "const",
  "var",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asGoSymbol(value: unknown): GoSymbol | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, qualified, kind, startLine, endLine, signature, doc, exported } = value;
  if (
    typeof name !== "string" ||
    typeof qualified !== "string" ||
    typeof kind !== "string" ||
    !GO_KINDS.has(kind) ||
    typeof startLine !== "number" ||
    typeof endLine !== "number" ||
    typeof signature !== "string" ||
    typeof doc !== "string" ||
    typeof exported !== "boolean"
  ) {
    return undefined;
  }
  return {
    name,
    qualified,
    kind: kind as SymbolDraft["kind"],
    startLine,
    endLine,
    signature,
    doc,
    exported,
  };
}

/** Runs the built extractor on one file. Parse errors become a warning, never a throw. */
export async function extractGo(
  binary: string,
  relPath: string,
  absolutePath: string,
  text: string,
): Promise<FileExtraction> {
  const outcome = await runProcess(binary, [absolutePath], {
    timeoutMs: RUN_TIMEOUT_MS,
    maxBuffer: RUN_MAX_OUTPUT,
  });
  if (!outcome.ok) {
    return skipped(`go parse failed for ${relPath}: ${outcome.stderr.trim().slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.stdout);
  } catch {
    return skipped(`go extractor returned unexpected output for ${relPath}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.symbols) || !Array.isArray(parsed.imports)) {
    return skipped(`go extractor returned unexpected output for ${relPath}`);
  }
  const lines = text.split(/\r?\n/);
  const symbols: SymbolInput[] = [];
  for (const raw of parsed.symbols) {
    const symbol = asGoSymbol(raw);
    if (symbol === undefined) {
      return skipped(`go extractor returned an invalid symbol for ${relPath}`);
    }
    symbols.push(makeSymbol(symbol, lines));
  }
  const imports: ImportRecord[] = [];
  for (const raw of parsed.imports) {
    if (typeof raw !== "string") {
      return skipped(`go extractor returned an invalid import for ${relPath}`);
    }
    imports.push({ specifier: raw, bindings: [] });
  }
  const result: ExtractionResult = { symbols, imports, calls: [] };
  return { result };
}
