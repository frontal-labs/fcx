# Architecture

fcx follows a layered architecture where **the harness does the thinking; the model fills small, constrained slots.**

## Layers

1. **CLI** (`cli/`) — Command dispatch, JSON/text output, socket warm-reuse
2. **Router** (`packages/recipes/`) — Constrained enum → recipe | "unsupported"
3. **Recipe** — Each recipe gathers context, builds schema, generates, applies checks
4. **Context Engine** (`packages/retrieve/`, `packages/index/`) — Graph + BM25 + vectors + LSP
5. **Generator** (`packages/model/`) — ggml-node handles with schema-constrained output
6. **Defense** (`packages/defense/`) — Constrain → Ground → Anchor → Verify → Cite → Abstain
7. **Apply/UI** (`packages/apply/`) — Diff, permissions, undo, escalate

## Cross-cutting

Config + trust + policy (shared with Frontal Code), logs, memory.

## Tech Stack

- TypeScript (strict mode, ESM)
- Node.js >= 22
- bun, Biome, Ultracite, vitest, tsup, changesets, husky
- zod schemas
- tree-sitter (web-tree-sitter WASM)
- better-sqlite3 (FTS5, sqlite-vec)
- ggml-node (generation + embedding models)
- vscode-jsonrpc (LSP)
- @vscode/ripgrep

## Repository Layout

```
fcx/
  cli/              # fcx binary (moved from packages/cli/)
  packages/
    config/         # Config, trust, policy resolution
    model/          # ggml-node wrapper, model worker, registry
    index/          # Tree-sitter extraction, graph store, embeddings
    retrieve/       # Hybrid retrieval, context packing
    recipes/        # Router + 10 recipes
    defense/        # Six check layers
    verify/         # Per-language verifiers
    apply/          # Edit application, backups, undo
    memory/         # Local project memory
    escalate/       # Hosted model escalation
    acp/            # ACP server over stdio
  evals/            # Task sets, runner, reports
  training/         # Distillation data, fine-tuning, GGUF export
  fixtures/         # Test fixtures (config parity, repos)
  registry/         # Model registry
  recipes/prompts/  # Recipe system prompts
  schemas/          # JSON schemas
  tools/            # Tool definitions
  scripts/          # Utility scripts
  benchmarks/       # Speed benchmarks
  logs/             # Structured JSON logs
  run/              # Unix socket directory
  homebrew/         # Homebrew formula
  bin/              # Multi-platform bin entry
  skills/           # Skill definitions
```
