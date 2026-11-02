# Indexing

Tree-sitter based code graph indexing using SQLite (`index.sqlite`).

## Schema

- `files` — path, lang, hash, mtime, size
- `symbols` — name, qualified, kind, start_line, end_line, signature, doc, exported
- `edges` — src, dst, kind (defines, imports, calls, references, implements, tests, co_changes)
- `chunks` — text, tokens (FTS5 + vectors)
- `deps` — lang, package, version, symbol, kind, signature
- `memory` — symbol_id, file_id, kind, text, source, created_at

## Pipeline

1. Discover files (ripgrep, respects .gitignore)
2. Hash and skip unchanged
3. Extract symbols/imports/calls (tree-sitter queries per language)
4. Resolve imports to files (tsconfig, go.mod, Cargo.toml, Python roots)
5. Make edges precise (LSP for ambiguous calls)
6. Test edges (match test files to symbols)
7. Co-change edges (git log, count ≥ 3)
8. Chunks (one per symbol, capped at 256 tokens)
9. Dependency APIs (.d.ts, stubs, go list, rust-analyzer)
10. Incremental (hash check at command start)

## Languages

TypeScript, Python, Go, Rust.

## Packages

- `@fcx/index` — index store
- `@fcx/retrieve` — hybrid retrieval
