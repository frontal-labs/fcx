# Retrieval

Hybrid retrieval: BM25 + vectors + graph expansion + context packing.

## Algorithm

1. **Seeds** — Target symbol always included
2. **Query** — Identifiers from input + user natural-language text
3. **BM25** — Top 50 from `chunk_fts`
4. **Vector** — Top 50 from `chunk_vec` (embed query)
5. **Merge** — Reciprocal rank fusion: `score = Σ 1/(60 + rank)`. Top 10 + seeds.
6. **Expand** — 1 hop from hits (2 hops from target) over calls/references/imports/implements/tests/co_changes
7. **Pack** — Blocks into `contextBudgetTokens` (default 3000)
8. **Emit** — `ContextBundle` with blocks + allow-lists (paths, symbolsInScope, importablePackages)

## Embedding Model

Configurable via `fc.embeddingModel`. Default: `ggml/bge-small-en-v1.5`. M1 compares against at least one code-specific embedding GGUF.

## Packages

- `@fcx/retrieve` — `retrieve(task): ContextBundle`
