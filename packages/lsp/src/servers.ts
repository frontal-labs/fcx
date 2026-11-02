import { constants, access, realpath } from "node:fs/promises";
import { delimiter, dirname, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LspError } from "./errors.js";
import type {
  DetectOptions,
  DetectedServer,
  Language,
  ServerCommand,
  ServerSource,
} from "./types.js";
import { LANGUAGES } from "./types.js";

interface ServerSpec {
  readonly binaries: readonly string[];
  readonly args: readonly string[];
  readonly initializationOptions?: (tsserverPath: string | undefined) => Record<string, unknown>;
}

const SPECS: Readonly<Record<Language, ServerSpec>> = {
  typescript: {
    binaries: ["typescript-language-server"],
    args: ["--stdio"],
    initializationOptions: (tsserverPath) =>
      tsserverPath === undefined ? {} : { tsserver: { path: tsserverPath } },
  },
  rust: { binaries: ["rust-analyzer"], args: [] },
  go: { binaries: ["gopls"], args: [] },
  python: { binaries: ["pyright-langserver", "basedpyright-langserver"], args: ["--stdio"] },
};

const EXTENSIONS: Readonly<Record<string, Language>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".pyi": "python",
};

/** Language served by the pool for a file path, or undefined when no server covers it. */
export function languageForFile(file: string): Language | undefined {
  return EXTENSIONS[extname(file).toLowerCase()];
}

/** Find an executable by name in `pathEnv`, the way a shell would. */
async function findOnPath(name: string, pathEnv: string): Promise<string | undefined> {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The directory of this module, used to find the repo's own node_modules. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Ancestors of the module directory, nearest first: packages/lsp/src, packages/lsp, packages, repo root, ... */
function moduleAncestors(): string[] {
  const dirs: string[] = [];
  let current = MODULE_DIR;
  for (;;) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) return dirs;
    current = parent;
  }
}

/** True when `path` resolves (through symlinks) to a location inside `root`. */
async function resolvesInside(root: string, path: string): Promise<boolean> {
  try {
    const realRoot = await realpath(root);
    const realPath = await realpath(path);
    const rel = relative(realRoot, realPath);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/**
 * Find `node_modules/.bin/<name>`. The workspace is searched only when trusted, and only for
 * paths that stay inside it after symlinks are resolved. Then the repo's own install, then PATH.
 */
async function findNodeBin(
  workspace: string,
  name: string,
  trusted: boolean,
): Promise<{ path: string; source: ServerSource } | undefined> {
  const inWorkspace = join(workspace, "node_modules", ".bin", name);
  if (
    trusted &&
    (await isExecutable(inWorkspace)) &&
    (await resolvesInside(workspace, inWorkspace))
  ) {
    return { path: inWorkspace, source: "workspace" };
  }
  for (const dir of moduleAncestors()) {
    const candidate = join(dir, "node_modules", ".bin", name);
    if (await isExecutable(candidate)) return { path: candidate, source: "repo" };
  }
  return undefined;
}

/** Find the tsserver entry point that typescript-language-server should use. */
async function findTsserver(workspace: string, trusted: boolean): Promise<string | undefined> {
  const entry = join("node_modules", "typescript", "lib", "tsserver.js");
  const candidates = [
    ...(trusted ? [join(workspace, entry)] : []),
    ...moduleAncestors().map((d) => join(d, entry)),
  ];
  for (const candidate of candidates) {
    if ((await fileExists(candidate)) && (await resolvesInside(dirname(candidate), candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectOne(
  language: Language,
  workspace: string,
  options: DetectOptions,
): Promise<DetectedServer> {
  const spec = SPECS[language];
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const trusted = options.trustWorkspace === true;
  for (const binary of spec.binaries) {
    const found = await findNodeBin(workspace, binary, trusted);
    const resolved =
      found ??
      (await findOnPath(binary, pathEnv).then((path) =>
        path === undefined ? undefined : { path, source: "path" as const },
      ));
    if (resolved === undefined) continue;

    let initializationOptions: Record<string, unknown> | undefined;
    if (language === "typescript") {
      const tsserver = await findTsserver(workspace, trusted);
      if (tsserver === undefined) {
        return {
          language,
          available: false,
          reason: `${binary} found, but no typescript package (node_modules/typescript) in the workspace or the repo`,
        };
      }
      initializationOptions = spec.initializationOptions?.(tsserver);
    } else {
      initializationOptions = spec.initializationOptions?.(undefined);
    }

    const command: ServerCommand = {
      command: resolved.path,
      args: spec.args,
      ...(initializationOptions === undefined ? {} : { initializationOptions }),
    };
    return {
      language,
      available: true,
      command,
      binaryPath: resolved.path,
      source: resolved.source,
    };
  }
  return {
    language,
    available: false,
    reason: `none of ${spec.binaries.join(", ")} found in the workspace, the repo, or PATH`,
  };
}

/**
 * Detect the language server binary for every supported language. Never installs anything.
 * Order of lookup: workspace node_modules (only when `trustWorkspace` is set), repo node_modules, then PATH.
 */
export async function detectServers(
  workspace: string,
  options: DetectOptions = {},
): Promise<readonly DetectedServer[]> {
  if (!isAbsolute(workspace)) {
    throw new LspError("INVALID_ARGUMENT", `workspace must be an absolute path: ${workspace}`);
  }
  return Promise.all(LANGUAGES.map((language) => detectOne(language, workspace, options)));
}
