import { afterEach, describe, expect, it } from "vitest";
import { type IndexStore, indexWorkspace, openIndex } from "../src/index.js";
import { type Workspace, hasCommand, makeWorkspace, writeFile } from "./helpers.js";

const hasPython = hasCommand("python3", ["--version"]);

const SOURCE = `import os
from .util import helper as h
from . import sibling
from pkg.mod import thing

MAX_RETRIES = 3


def top(a, b=1) -> int:
    """Adds two numbers."""
    return a + b


async def fetch(url):
    return url


class Store(Base):
    """Keeps items."""

    def load(self, path):
        return path

    async def save(self):
        pass

    def _private(self):
        pass

    class Inner:
        def deep(self):
            pass
`;

let ws: Workspace | undefined;
let store: IndexStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  ws?.cleanup();
  ws = undefined;
});

async function indexed(files: Record<string, string>): Promise<IndexStore> {
  ws = makeWorkspace(files);
  const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
  store = openIndex(ws.dbPath);
  expect(summary.warnings).toEqual([]);
  return store;
}

function symbolsOf(db: IndexStore, path: string): Map<string, { kind: string; exported: boolean }> {
  const file = db.fileByPath(path);
  if (file === undefined) {
    throw new Error(`${path} is not indexed`);
  }
  return new Map(
    db.symbolsInFile(file.id).map((s) => [s.qualified, { kind: s.kind, exported: s.exported }]),
  );
}

describe.skipIf(!hasPython)("python extraction (python3 ast)", () => {
  it("reports functions, classes, methods, nested classes and constants with kinds", async () => {
    const db = await indexed({ "app/mod.py": SOURCE });
    const symbols = symbolsOf(db, "app/mod.py");
    expect(symbols.get("top")?.kind).toBe("function");
    expect(symbols.get("fetch")?.kind).toBe("function");
    expect(symbols.get("Store")?.kind).toBe("class");
    expect(symbols.get("Store.load")?.kind).toBe("method");
    expect(symbols.get("Store.save")?.kind).toBe("method");
    expect(symbols.get("Store.Inner")?.kind).toBe("class");
    expect(symbols.get("Store.Inner.deep")?.kind).toBe("method");
    expect(symbols.get("MAX_RETRIES")?.kind).toBe("const");
    expect(symbols.has("os")).toBe(false);
  });

  it("marks underscore names as not exported and keeps docstrings", async () => {
    const db = await indexed({ "mod.py": SOURCE });
    const symbols = symbolsOf(db, "mod.py");
    expect(symbols.get("Store._private")?.exported).toBe(false);
    expect(symbols.get("Store.load")?.exported).toBe(true);
    const file = db.fileByPath("mod.py");
    const top = db.symbolsInFile(file?.id ?? -1).find((s) => s.qualified === "top");
    expect(top?.doc).toBe("Adds two numbers.");
    expect(top?.signature).toBe("def top(a, b=1) -> int");
  });

  it("resolves relative imports to files and records external imports without an edge", async () => {
    const db = await indexed({
      "pkg/app.py":
        "from .util import helper as h\nfrom . import sibling\nfrom pkg.mod import thing\n",
      "pkg/util.py": "def helper():\n    return 1\n",
      "pkg/sibling.py": "X = 1\n",
    });
    const id = (path: string): number => db.fileByPath(path)?.id ?? -1;
    const targets = db
      .neighborFiles(id("pkg/app.py"), ["imports"])
      .filter((n) => n.direction === "out")
      .map((n) => n.fileId)
      .sort((a, b) => a - b);
    expect(targets).toEqual([id("pkg/sibling.py"), id("pkg/util.py")].sort((a, b) => a - b));
  });

  it("warns and skips a file that does not parse, without failing the index", async () => {
    ws = makeWorkspace({
      "good.py": "def ok():\n    return 1\n",
      "bad.py": "def broken(:\n    pass\n",
    });
    const summary = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    store = openIndex(ws.dbPath);
    expect(summary.warnings.some((w) => w.includes("bad.py"))).toBe(true);
    expect(symbolsOf(store, "good.py").has("ok")).toBe(true);
    expect(symbolsOf(store, "bad.py").size).toBe(0);
  });

  it("re-extracts only the edited file on an incremental run", async () => {
    ws = makeWorkspace({
      "a.py": "def one():\n    return 1\n",
      "b.py": "def two():\n    return 2\n",
    });
    const first = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(first.filesChanged).toBe(2);
    writeFile(ws.root, "a.py", "def renamed():\n    return 1\n");
    const second = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(second.filesChanged).toBe(1);
    store = openIndex(ws.dbPath);
    expect(symbolsOf(store, "a.py").has("renamed")).toBe(true);
    expect(symbolsOf(store, "a.py").has("one")).toBe(false);
    expect(symbolsOf(store, "b.py").has("two")).toBe(true);
  });
});
