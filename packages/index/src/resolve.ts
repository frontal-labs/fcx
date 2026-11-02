import { existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";

interface ResolverConfig {
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
}

const DEFAULT_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  resolveJsonModule: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2022,
  noEmit: true,
};

/**
 * Resolves import specifiers to workspace files with the TypeScript module resolver. The
 * nearest `tsconfig.json` (up to the workspace root) supplies `paths`, `baseUrl` and the
 * resolution mode. Packages that resolve into node_modules are not workspace files and return
 * undefined.
 */
export class ModuleResolver {
  readonly #root: string;
  readonly #byDirectory = new Map<string, ResolverConfig>();

  /** `root` must be an absolute, real path. */
  constructor(root: string) {
    this.#root = root;
  }

  /** Returns the absolute path of the workspace file that `specifier` resolves to, if any. */
  resolve(importerAbsolute: string, specifier: string): string | undefined {
    const config = this.#configFor(dirname(importerAbsolute));
    const result = ts.resolveModuleName(
      specifier,
      importerAbsolute,
      config.options,
      ts.sys,
      config.cache,
    );
    const resolved = result.resolvedModule;
    if (resolved === undefined || resolved.isExternalLibraryImport === true) {
      return undefined;
    }
    const file = resolved.resolvedFileName;
    const rel = relative(this.#root, file);
    if (rel.startsWith("..") || rel.split(sep).includes("node_modules")) {
      return undefined;
    }
    return file;
  }

  #configFor(directory: string): ResolverConfig {
    const cached = this.#byDirectory.get(directory);
    if (cached) {
      return cached;
    }
    const options = this.#optionsFor(directory);
    const config: ResolverConfig = {
      options,
      cache: ts.createModuleResolutionCache(this.#root, (name) => name, options),
    };
    this.#byDirectory.set(directory, config);
    return config;
  }

  #optionsFor(directory: string): ts.CompilerOptions {
    let current = directory;
    for (;;) {
      const candidate = join(current, "tsconfig.json");
      if (existsSync(candidate)) {
        return parseOptions(candidate);
      }
      const rel = relative(this.#root, current);
      if (current === this.#root || rel === "" || rel.startsWith("..")) {
        break;
      }
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    return DEFAULT_OPTIONS;
  }
}

function parseOptions(configPath: string): ts.CompilerOptions {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) {
    return DEFAULT_OPTIONS;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(configPath));
  return {
    ...parsed.options,
    allowJs: true,
    noEmit: true,
    moduleResolution: parsed.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
  };
}
