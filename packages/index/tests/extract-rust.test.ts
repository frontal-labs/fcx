import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractRust } from "../src/extractors/rust.js";
import { type IndexStore, indexWorkspace, openIndex } from "../src/index.js";
import { type Workspace, makeWorkspace, writeFile } from "./helpers.js";

/** The Rust extractor is a line-based heuristic; these tests pin the cases it is meant to get. */
const LIB = `use crate::util::helper;
use std::fmt::{self, Display};
mod net;
mod inline {
    pub fn f() {}
}

pub const LIMIT: u32 = 10;
static NAME: &str = "x";

/// A store of items.
pub struct Store {
    items: Vec<u32>,
}

pub enum Mode {
    A,
    B,
}

pub trait Reader {
    fn read(&self) -> u8;
}

impl Store {
    /// Creates an empty store.
    pub fn new() -> Self {
        Store { items: Vec::new() }
    }

    fn hidden(&self) {}
}

impl Reader for Store {
    fn read(&self) -> u8 {
        let brace = "{ fn fake() {} }";
        /* fn ignored() { */ 0
    }
}

fn helper() -> u8 {
    1
}

fn after_block_comment() {}
`;

let ws: Workspace | undefined;
let store: IndexStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  ws?.cleanup();
  ws = undefined;
});

function byQualified(
  source: string,
): Map<string, ReturnType<typeof extractRust>["result"]["symbols"][number]> {
  const { result } = extractRust(source);
  return new Map(result.symbols.map((s) => [s.qualified, s]));
}

describe("rust extraction (line-based heuristic)", () => {
  it("reports top-level items, impl and trait methods, with kinds and qualified names", () => {
    const symbols = byQualified(LIB);
    expect(symbols.get("LIMIT")?.kind).toBe("const");
    expect(symbols.get("NAME")?.kind).toBe("var");
    expect(symbols.get("Store")?.kind).toBe("class");
    expect(symbols.get("Mode")?.kind).toBe("enum");
    expect(symbols.get("Reader")?.kind).toBe("interface");
    expect(symbols.get("Store.new")?.kind).toBe("method");
    expect(symbols.get("Store.hidden")?.kind).toBe("method");
    expect(symbols.get("Reader.read")?.kind).toBe("method");
    expect(symbols.get("helper")?.kind).toBe("function");
    expect(symbols.get("inline")?.kind).toBe("module");
    expect(symbols.get("inline.f")?.kind).toBe("function");
    expect(symbols.get("after_block_comment")?.kind).toBe("function");
  });

  it("ignores items that appear only inside strings or comments", () => {
    const symbols = byQualified(LIB);
    expect(symbols.has("fake")).toBe(false);
    expect(symbols.has("ignored")).toBe(false);
  });

  it("takes exported from pub and doc comments from /// lines", () => {
    const symbols = byQualified(LIB);
    expect(symbols.get("Store")?.exported).toBe(true);
    expect(symbols.get("Store")?.doc).toBe("A store of items.");
    expect(symbols.get("Store.new")?.doc).toBe("Creates an empty store.");
    expect(symbols.get("Store.hidden")?.exported).toBe(false);
    expect(symbols.get("helper")?.exported).toBe(false);
  });

  it("gives line ranges that cover the item body", () => {
    const symbols = byQualified(LIB);
    const hidden = symbols.get("Store.hidden");
    expect(hidden?.startLine).toBe(LIB.split("\n").findIndex((l) => l.includes("fn hidden")) + 1);
    expect(hidden?.endLine).toBe(hidden?.startLine);
    const newFn = symbols.get("Store.new");
    expect((newFn?.endLine ?? 0) - (newFn?.startLine ?? 0)).toBe(2);
  });

  it("records use paths and mod declarations as imports", () => {
    const { result } = extractRust(LIB);
    const specifiers = result.imports.map((i) => i.specifier);
    expect(specifiers).toContain("crate::util::helper");
    expect(specifiers).toContain("std::fmt");
    expect(specifiers).toContain("std::fmt::Display");
    expect(specifiers).toContain("mod net");
  });

  it("does not throw on an unterminated item and keeps the items before it", () => {
    const { result } = extractRust("fn ok() {}\nstruct Broken {\n    x: u8,\n");
    expect(result.symbols.map((s) => s.qualified)).toEqual(["ok", "Broken"]);
  });
});

describe("rust edges and incremental indexing", () => {
  it("resolves crate:: uses and mod declarations to files under src/", async () => {
    ws = makeWorkspace({
      "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
      "src/lib.rs": "use crate::util::helper;\nmod net;\nuse std::fmt;\n",
      "src/util.rs": "pub fn helper() {}\n",
      "src/net.rs": "pub fn connect() {}\n",
    });
    await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    store = openIndex(ws.dbPath);
    const id = (path: string): number => store?.fileByPath(path)?.id ?? -1;
    const targets = store
      .neighborFiles(id("src/lib.rs"), ["imports"])
      .filter((n) => n.direction === "out")
      .map((n) => n.fileId)
      .sort((a, b) => a - b);
    expect(targets).toEqual([id("src/net.rs"), id("src/util.rs")].sort((a, b) => a - b));
  });

  it("re-extracts only the edited file on an incremental run", async () => {
    ws = makeWorkspace({
      "src/a.rs": "pub fn one() {}\n",
      "src/b.rs": "pub fn two() {}\n",
    });
    const first = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(first.filesChanged).toBe(2);
    writeFile(ws.root, "src/a.rs", "pub fn renamed() {}\n");
    const second = await indexWorkspace(ws.root, { dbPath: ws.dbPath });
    expect(second.filesChanged).toBe(1);
    store = openIndex(ws.dbPath);
    const a = store.fileByPath("src/a.rs");
    expect(store.symbolsInFile(a?.id ?? -1).map((s) => s.qualified)).toEqual(["renamed"]);
  });
});

/** Runs over real crates from the local cargo registry when present. Skipped otherwise. */
const CARGO_SRC = join(homedir(), ".cargo", "registry", "src");
describe.skipIf(!existsSync(CARGO_SRC))("rust extraction on real crates", () => {
  it("extracts from real crate sources without throwing and with sane line ranges", () => {
    const files: string[] = [];
    for (const registry of readdirSync(CARGO_SRC).slice(0, 2)) {
      const crates = readdirSync(join(CARGO_SRC, registry)).slice(0, 40);
      for (const crate of crates) {
        const src = join(CARGO_SRC, registry, crate, "src", "lib.rs");
        if (existsSync(src) && statSync(src).size < 300_000) {
          files.push(src);
        }
      }
    }
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { result } = extractRust(readFileSync(file, "utf8"));
      for (const symbol of result.symbols) {
        expect(symbol.startLine).toBeLessThanOrEqual(symbol.endLine);
      }
    }
  });
});
