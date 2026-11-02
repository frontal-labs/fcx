# @fcx/retrieve

## Description

Skill for fcx hybrid retrieval: BM25, vectors, graph expansion, and context packing. Implements the `@fcx/retrieve` package (now `fcx-retrieve`).

## Algorithm

1. **Seeds** — Target symbol always included
2. **Query** — Identifiers from input + user natural-language text
3. **BM25** — Top 50 from `chunk_fts`
4. **Vector** — Top 50 from `chunk_vec` (embed query)
5. **Merge** — Reciprocal rank fusion: `score = Σ 1/(60 + rank)`. Top 10 + seeds.
6. **Expand** — 1 hop from hits (2 hops from target) over calls/references/imports/implements/tests/co_changes
7. **Pack** — Blocks into `contextBudgetTokens` (default 3000)
8. **Emit** — `ContextBundle` with blocks + allow-lists

## Embedding Model

Configurable via `fc.embeddingModel`. Default: `ggml/bge-small-en-v1.5`.

## Files

- `packages/retrieve/src/` — Retrieval implementations
- `docs/RETRIEVAL.md` — Full retrieval spec

## License

Apache-2.0
