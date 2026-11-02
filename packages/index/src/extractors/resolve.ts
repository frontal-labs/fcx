/**
 * File-level resolution for Python, Go and Rust imports. Each function returns absolute paths
 * of workspace files only. Anything that is not a workspace file (standard library, third-party
 * packages, other modules) returns no paths and is recorded as an external import, with no edge.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !rel.split(sep).includes("node_modules");
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** Walks up from `start` to `root` (inclusive) and returns the first directory with `name`. */
function findUpwards(root: string, start: string, name: string): string | undefined {
  let current = start;
  for (;;) {
    if (existsSync(join(current, name))) {
      return current;
    }
    if (current === root || !isInside(root, current)) {
      return undefined;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Python: only relative imports (`from .x import y`, specifier `.x`) resolve. The leading dots
 * climb from the importer's directory; the rest is a dotted module path.
 */
export function resolvePythonImport(root: string, importer: string, specifier: string): string[] {
  const level = /^\.*/.exec(specifier)?.[0].length ?? 0;
  if (level === 0) {
    return [];
  }
  let base = dirname(importer);
  for (let i = 1; i < level; i++) {
    base = dirname(base);
  }
  const module = specifier.slice(level);
  const target = module === "" ? [] : module.split(".");
  const candidates =
    target.length === 0
      ? [join(base, "__init__.py")]
      : [`${join(base, ...target)}.py`, join(base, ...target, "__init__.py")];
  for (const candidate of candidates) {
    if (isFile(candidate) && isInside(root, candidate)) {
      return [candidate];
    }
  }
  return [];
}

export interface GoModule {
  readonly modulePath: string;
  readonly moduleDir: string;
}

/** Caches `go.mod` lookups for one indexing run. */
export class GoModuleCache {
  readonly #root: string;
  readonly #byDirectory = new Map<string, GoModule | null>();

  constructor(root: string) {
    this.#root = root;
  }

  moduleFor(directory: string): GoModule | undefined {
    const cached = this.#byDirectory.get(directory);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const moduleDir = findUpwards(this.#root, directory, "go.mod");
    let found: GoModule | null = null;
    if (moduleDir !== undefined) {
      const declaration = /^module\s+(\S+)/m.exec(readFileSync(join(moduleDir, "go.mod"), "utf8"));
      if (declaration?.[1] !== undefined) {
        found = { modulePath: declaration[1].replace(/^"|"$/g, ""), moduleDir };
      }
    }
    this.#byDirectory.set(directory, found);
    return found ?? undefined;
  }
}

/**
 * Go: an import path inside the importer's module (the `module` line of the nearest go.mod)
 * resolves to every non-test `.go` file of the package directory. Other paths are external.
 */
export function resolveGoImport(
  root: string,
  importer: string,
  specifier: string,
  modules: GoModuleCache,
): string[] {
  const module = modules.moduleFor(dirname(importer));
  if (module === undefined) {
    return [];
  }
  const { modulePath, moduleDir } = module;
  if (specifier !== modulePath && !specifier.startsWith(`${modulePath}/`)) {
    return [];
  }
  const rest = specifier.slice(modulePath.length).replace(/^\//, "");
  const directory = rest === "" ? moduleDir : join(moduleDir, ...rest.split("/"));
  if (!isInside(root, directory) || !existsSync(directory)) {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".go") && !name.endsWith("_test.go"))
    .sort()
    .map((name) => join(directory, name))
    .filter((path) => isFile(path));
}

/** Crate source root (`<dir of Cargo.toml>/src`) for a Rust file, or undefined. */
function crateSourceFor(root: string, importer: string): string | undefined {
  const crateDir = findUpwards(root, dirname(importer), "Cargo.toml");
  return crateDir === undefined ? undefined : join(crateDir, "src");
}

/**
 * Rust: `crate::a::b` resolves to `src/a/b.rs` or `src/a/b/mod.rs`, trying the longest path
 * first so that `crate::a::b::Item` finds `a/b.rs`. `mod x;` (specifier `mod x`) resolves
 * relative to the declaring file. Other paths are external.
 */
export function resolveRustImport(root: string, importer: string, specifier: string): string[] {
  if (specifier.startsWith("mod ")) {
    const name = specifier.slice(4).trim();
    const directory = dirname(importer);
    const stem = importer.slice(importer.lastIndexOf(sep) + 1).replace(/\.rs$/, "");
    const isModuleRoot = stem === "mod" || stem === "lib" || stem === "main";
    const base = isModuleRoot ? directory : join(directory, stem);
    for (const candidate of [join(base, `${name}.rs`), join(base, name, "mod.rs")]) {
      if (isFile(candidate) && isInside(root, candidate)) {
        return [candidate];
      }
    }
    return [];
  }
  if (!specifier.startsWith("crate::")) {
    return [];
  }
  const source = crateSourceFor(root, importer);
  if (source === undefined) {
    return [];
  }
  const segments = specifier
    .slice("crate::".length)
    .split("::")
    .filter((s) => s.length > 0);
  for (let length = segments.length; length >= 1; length--) {
    const base = join(source, ...segments.slice(0, length));
    for (const candidate of [`${base}.rs`, join(base, "mod.rs")]) {
      if (isFile(candidate) && isInside(root, candidate)) {
        return [candidate];
      }
    }
  }
  return [];
}
