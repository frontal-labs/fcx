import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { confine } from "./confine.js";
import { findTsconfig, isWithin } from "./paths.js";
import type { Checker, Diagnostic } from "./types.js";

export const FALLBACK_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowJs: true,
  checkJs: false,
  esModuleInterop: true,
};

/** Creates a TypeScript language service rooted at the project containing `file`. */
export function createTsChecker(root: string, file: string): Checker {
  const tsconfigPath = findTsconfig(root, file);
  let options: ts.CompilerOptions = { ...FALLBACK_OPTIONS };
  let fileNames: string[] = [resolve(file)];

  if (tsconfigPath) {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error) {
      throw new Error(
        `Cannot read ${tsconfigPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, "\n")}`,
      );
    }
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      dirname(tsconfigPath),
      undefined,
      tsconfigPath,
    );
    options = confine({ ...parsed.options, noEmit: true }, dirname(tsconfigPath), resolve(root));
    // Only files inside the workspace are program inputs. A repo's `include` can name anything.
    fileNames = parsed.fileNames.filter((f) => isWithin(resolve(root), f));
    if (fileNames.length === 0) fileNames = [resolve(file)];
  }
  const target = resolve(file);
  if (!fileNames.includes(target)) fileNames = [...fileNames, target];

  const versions = new Map<string, number>();
  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);
  let overrides: ReadonlyMap<string, string> = new Map();
  const readText = (path: string): string | undefined => {
    const override = overrides.get(path);
    if (override !== undefined) return override;
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => fileNames,
    getScriptVersion: (path) => String(versions.get(path) ?? 0),
    getScriptSnapshot: (path) => {
      const text = readText(path);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfigPath ?? target),
    getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    fileExists: (path) => overrides.has(path) || existsSync(path),
    readFile: (path) => readText(path),
    directoryExists: (path) => existsSync(path) && statSync(path).isDirectory(),
    realpath: ts.sys.realpath,
    readDirectory: ts.sys.readDirectory,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host, ts.createDocumentRegistry());

  return {
    service,
    options,
    diagnostics(path, nextOverrides = new Map()) {
      const abs = resolve(path);
      // Bump every file whose override changed, so the service re-parses it.
      for (const key of new Set([...overrides.keys(), ...nextOverrides.keys()])) {
        if (overrides.get(key) !== nextOverrides.get(key)) bump(key);
      }
      overrides = nextOverrides;
      if (!fileNames.includes(abs)) fileNames = [...fileNames, abs];
      return collect(service, abs);
    },
    dispose() {
      service.dispose();
    },
  };
}

export function collect(service: ts.LanguageService, file: string): Diagnostic[] {
  const program = service.getProgram();
  const source = program?.getSourceFile(file);
  if (!program || !source) return [];
  const all = [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ];
  return all.map((d) => {
    const pos = d.start ?? 0;
    const { line, character } = source.getLineAndCharacterOfPosition(pos);
    return {
      file,
      line: line + 1,
      column: character + 1,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      category: categoryName(d.category),
    };
  });
}

export function categoryName(category: ts.DiagnosticCategory): Diagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}
