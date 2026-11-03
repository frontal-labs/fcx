import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureGoExtractor } from "../src/extractors/go.js";
import { type IndexStore, indexWorkspace, openIndex } from "../src/index.js";
import { type Workspace, hasCommand, makeWorkspace, writeFile } from "./helpers.js";

const hasGo = hasCommand("go", ["version"]);
const GO_MAIN = fileURLToPath(new URL("../src/extractors/go/main.go", import.meta.url));

const GO_MOD = "module example.com/proj\n\ngo 1.22\n";

const STORE_SOURCE = `package store

import (
	"fmt"

	"example.com/proj/util"
)

// MaxItems bounds the store.
const MaxItems = 10

// Item is one stored value.
type Item struct {
	Name string
}

// Reader reads items.
type Reader interface {
	Read() Item
}

// Store keeps items.
type Store struct {
	items []Item
}

// New makes a store.
func New() *Store {
	return &Store{}
}

// Get returns an item by index.
func (s *Store) Get(i int) Item {
	fmt.Println(util.Help())
	return s.items[i]
}

func (s *Store) reset() {}
`;

let ws: Workspace | undefined;
let store: IndexStore | undefined;
let scratch: string | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  ws?.cleanup();
  ws = undefined;
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

async function indexed(files: Record<string, string>): Promise<IndexStore> {
  ws = makeWorkspace(files);
  const summary = await indexWorkspace(ws.root, {
    dbPath: ws.dbPath,
    goCacheDir: join(ws.root, "..", "go-cache"),
  });
  store = openIndex(ws.dbPath);
  // The message carries the warning text, so a failure shows why the file was skipped.
  expect(summary.warnings, summary.warnings.join("; ")).toEqual([]);
  return store;
}

describe.skipIf(!hasGo)("go extraction (go/ast via a built helper)", { timeout: 120_000 }, () => {
  it("reports functions, methods with receiver-qualified names, types, constants and kinds", async () => {
    const db = await indexed({
      "go.mod": GO_MOD,
      "store/store.go": STORE_SOURCE,
      "util/util.go": 'package util\n\nfunc Help() string { return "" }\n',
    });
    const file = db.fileByPath("store/store.go");
    const symbols = new Map(db.symbolsInFile(file?.id ?? -1).map((s) => [s.qualified, s]));
    expect(symbols.get("New")?.kind).toBe("function");
    expect(symbols.get("Store.Get")?.kind).toBe("method");
    expect(symbols.get("Store.reset")?.exported).toBe(false);
    expect(symbols.get("Store.Get")?.exported).toBe(true);
    expect(symbols.get("Store")?.kind).toBe("class");
    expect(symbols.get("Reader")?.kind).toBe("interface");
    expect(symbols.get("Item")?.kind).toBe("class");
    expect(symbols.get("MaxItems")?.kind).toBe("const");
    expect(symbols.get("New")?.doc).toBe("New makes a store.");
    expect(symbols.get("Store.Get")?.signature).toBe("func (s *Store) Get(i int) Item");
  });

  it("resolves package-local imports to the package's files and not external ones", async () => {
    const db = await indexed({
      "go.mod": GO_MOD,
      "store/store.go": STORE_SOURCE,
      "util/util.go": 'package util\n\nfunc Help() string { return "" }\n',
      "util/util_test.go": "package util\n",
    });
    const id = (path: string): number => db.fileByPath(path)?.id ?? -1;
    const targets = db
      .neighborFiles(id("store/store.go"), ["imports"])
      .filter((n) => n.direction === "out")
      .map((n) => n.fileId);
    expect(targets).toEqual([id("util/util.go")]);
  });

  it("warns and skips a file that does not parse, without failing the index", async () => {
    ws = makeWorkspace({
      "go.mod": GO_MOD,
      "ok/ok.go": "package ok\n\nfunc Fine() {}\n",
      "bad/bad.go": "package bad\n\nfunc broken( {\n",
    });
    const summary = await indexWorkspace(ws.root, {
      dbPath: ws.dbPath,
      goCacheDir: join(ws.root, "..", "go-cache"),
    });
    store = openIndex(ws.dbPath);
    expect(summary.warnings.some((w) => w.includes("bad/bad.go"))).toBe(true);
    const ok = store.fileByPath("ok/ok.go");
    expect(store.symbolsInFile(ok?.id ?? -1).map((s) => s.qualified)).toEqual(["Fine"]);
  });

  it("re-extracts only the edited file on an incremental run", async () => {
    ws = makeWorkspace({
      "go.mod": GO_MOD,
      "a/a.go": "package a\n\nfunc One() {}\n",
      "b/b.go": "package b\n\nfunc Two() {}\n",
    });
    const options = { dbPath: ws.dbPath, goCacheDir: join(ws.root, "..", "go-cache") };
    const first = await indexWorkspace(ws.root, options);
    expect(first.filesChanged).toBe(3);
    writeFile(ws.root, "a/a.go", "package a\n\nfunc Renamed() {}\n");
    const second = await indexWorkspace(ws.root, options);
    expect(second.filesChanged).toBe(1);
    store = openIndex(ws.dbPath);
    const a = store.fileByPath("a/a.go");
    expect(store.symbolsInFile(a?.id ?? -1).map((s) => s.qualified)).toEqual(["Renamed"]);
  });
});

describe.skipIf(!hasGo)("go extractor binary cache", { timeout: 120_000 }, () => {
  it("builds once, then reuses the cached binary keyed by the source sha256", async () => {
    scratch = mkdtempSync(join(tmpdir(), "fcx-go-cache-"));
    const first = await ensureGoExtractor(scratch);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const digest = createHash("sha256").update(readFileSync(GO_MAIN)).digest("hex");
    expect(basename(first.path)).toContain(digest);
    const mtime = statSync(first.path).mtimeMs;

    const second = await ensureGoExtractor(scratch);
    expect(second).toEqual({ ok: true, path: first.path, built: false });
    expect(statSync(first.path).mtimeMs).toBe(mtime);
  });
});
