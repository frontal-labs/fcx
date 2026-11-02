/**
 * Python extraction. Runs the interpreter's own `ast` module through `python3 -I -c` with the
 * file path passed in argv. Only top-level functions, classes (with their methods and nested
 * classes), top-level constants (UPPER_CASE assignments) and imports are reported.
 */
import type { ExtractionResult, ImportBinding, ImportRecord } from "../extract.js";
import type { SymbolInput } from "../types.js";
import {
  type FileExtraction,
  type SymbolDraft,
  makeSymbol,
  runProcess,
  skipped,
} from "./common.js";

const PYTHON_TIMEOUT_MS = 10_000;
const PYTHON_MAX_OUTPUT = 32 * 1024 * 1024;

const PYTHON_SCRIPT = String.raw`
import ast
import json
import re
import sys

MAX_BYTES = 2000000
MAX_SIG = 200
MAX_DOC = 400
CONST_NAME = re.compile(r"[A-Z][A-Z0-9_]*\Z")


def fail(message):
    sys.stderr.write(str(message)[:500])
    sys.exit(1)


def clip(text, limit):
    return " ".join(text.split())[:limit]


def doc_of(node):
    return (ast.get_docstring(node, clean=True) or "")[:MAX_DOC]


def first_line(node):
    lines = [node.lineno]
    for dec in getattr(node, "decorator_list", []):
        lines.append(dec.lineno)
    return min(lines)


def symbol(name, qualified, kind, node, signature, doc, exported):
    return {
        "name": name,
        "qualified": qualified,
        "kind": kind,
        "startLine": first_line(node),
        "endLine": node.end_lineno,
        "signature": clip(signature, MAX_SIG),
        "doc": doc,
        "exported": exported,
    }


def func_symbol(node, qualified, kind, exported):
    prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
    sig = prefix + node.name + "(" + ast.unparse(node.args) + ")"
    if node.returns is not None:
        sig += " -> " + ast.unparse(node.returns)
    return symbol(node.name, qualified, kind, node, sig, doc_of(node), exported)


def class_symbols(node, prefix, parent_public):
    public = parent_public and not node.name.startswith("_")
    parts = [ast.unparse(base) for base in node.bases]
    for kw in node.keywords:
        value = ast.unparse(kw.value)
        parts.append(kw.arg + "=" + value if kw.arg else "**" + value)
    sig = "class " + node.name
    if parts:
        sig += "(" + ", ".join(parts) + ")"
    qualified = prefix + node.name
    out = [symbol(node.name, qualified, "class", node, sig, doc_of(node), public)]
    for child in node.body:
        if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
            method_public = public and not child.name.startswith("_")
            out.append(func_symbol(child, qualified + "." + child.name, "method", method_public))
        elif isinstance(child, ast.ClassDef):
            out.extend(class_symbols(child, qualified + ".", public))
    return out


def const_symbol(target, node, value_text, annotation_text):
    name = target.id
    sig = name
    if annotation_text is not None:
        sig += ": " + annotation_text
    sig += " = " + value_text
    return symbol(name, name, "const", node, sig, "", True)


def main():
    if len(sys.argv) != 2:
        fail("usage: <file.py>")
    path = sys.argv[1]
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_BYTES + 1)
    except OSError as error:
        fail(error)
    if len(data) > MAX_BYTES:
        fail("file too large")
    try:
        tree = ast.parse(data, filename=path)
    except Exception as error:
        fail(error)

    symbols = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append(func_symbol(node, node.name, "function", not node.name.startswith("_")))
        elif isinstance(node, ast.ClassDef):
            symbols.extend(class_symbols(node, "", True))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and CONST_NAME.match(target.id):
                    symbols.append(const_symbol(target, node, ast.unparse(node.value), None))
        elif isinstance(node, ast.AnnAssign):
            target = node.target
            if node.value is not None and isinstance(target, ast.Name) and CONST_NAME.match(target.id):
                symbols.append(
                    const_symbol(target, node, ast.unparse(node.value), ast.unparse(node.annotation))
                )

    imports = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                bindings = [{"kind": "namespace", "local": alias.asname}] if alias.asname else []
                imports.append({"specifier": alias.name, "bindings": bindings})
        elif isinstance(node, ast.ImportFrom):
            prefix = "." * node.level
            module = node.module or ""
            names = [alias for alias in node.names if alias.name != "*"]
            bindings = [
                {"kind": "named", "local": alias.asname or alias.name, "imported": alias.name}
                for alias in names
            ]
            imports.append({"specifier": prefix + module, "bindings": bindings})
            if node.level > 0:
                for alias in names:
                    dotted = prefix + module + ("." if module else "") + alias.name
                    imports.append({"specifier": dotted, "bindings": []})

    sys.stdout.write(json.dumps({"symbols": symbols, "imports": imports}))


main()
`;

interface PythonSymbol {
  readonly name: string;
  readonly qualified: string;
  readonly kind: SymbolDraft["kind"];
  readonly startLine: number;
  readonly endLine: number;
  readonly signature: string;
  readonly doc: string;
  readonly exported: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SYMBOL_KINDS: ReadonlySet<string> = new Set(["function", "method", "class", "const"]);

function asSymbol(value: unknown): PythonSymbol | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { name, qualified, kind, startLine, endLine, signature, doc, exported } = value;
  if (
    typeof name !== "string" ||
    typeof qualified !== "string" ||
    typeof kind !== "string" ||
    !SYMBOL_KINDS.has(kind) ||
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

function asBindings(value: unknown): ImportBinding[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const bindings: ImportBinding[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.local !== "string") {
      return undefined;
    }
    if (item.kind === "namespace") {
      bindings.push({ kind: "namespace", local: item.local });
    } else if (item.kind === "named" && typeof item.imported === "string") {
      bindings.push({ kind: "named", local: item.local, imported: item.imported });
    } else {
      return undefined;
    }
  }
  return bindings;
}

function parseOutput(stdout: string, lines: readonly string[]): ExtractionResult | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.symbols) || !Array.isArray(parsed.imports)) {
    return undefined;
  }
  const symbols: SymbolInput[] = [];
  for (const raw of parsed.symbols) {
    const symbol = asSymbol(raw);
    if (symbol === undefined) {
      return undefined;
    }
    symbols.push(makeSymbol(symbol, lines));
  }
  const imports: ImportRecord[] = [];
  for (const raw of parsed.imports) {
    if (!isRecord(raw) || typeof raw.specifier !== "string") {
      return undefined;
    }
    const bindings = asBindings(raw.bindings);
    if (bindings === undefined) {
      return undefined;
    }
    imports.push({ specifier: raw.specifier, bindings });
  }
  return { symbols, imports, calls: [] };
}

/** Extracts symbols and imports from one Python file. Never throws. */
export async function extractPython(
  relPath: string,
  absolutePath: string,
  text: string,
): Promise<FileExtraction> {
  const outcome = await runProcess("python3", ["-I", "-c", PYTHON_SCRIPT, absolutePath], {
    timeoutMs: PYTHON_TIMEOUT_MS,
    maxBuffer: PYTHON_MAX_OUTPUT,
  });
  if (!outcome.ok && outcome.spawnCode === "ENOENT") {
    return {
      ...skipped(`python3 not found on PATH; ${relPath} was not indexed`),
      missingTool: "python3",
    };
  }
  if (!outcome.ok) {
    return skipped(`python parse failed for ${relPath}: ${outcome.stderr.trim()}`);
  }
  const result = parseOutput(outcome.stdout, text.split(/\r?\n/));
  if (result === undefined) {
    return skipped(`python extractor returned unexpected output for ${relPath}`);
  }
  return { result };
}
