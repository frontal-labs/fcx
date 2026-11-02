# fcx

![Frontal Banner](./banner.jpg)

**Frontal Code, extra small. Local, fast, and only shows you code that works.**

Local-first coding agent CLI. Uses a ~1.5B model locally with defense-in-depth checks.

## Status

Early development (M0). See PLAN.md for the full specification.

## Installation

### Homebrew (macOS/Linux)

```bash
brew install --formula ./homebrew/fcx.rb
```

### npm (global)

```bash
npm install -g @fcx/fcx
```

### Bun (global)

```bash
bun install -g @fcx/fcx
```

### From source

```bash
git clone https://github.com/frontal-labs/fcx.git
cd fcx
bun install
bun run build
# run directly
bunx tsx cli/src/index.ts --version
```

### Binary

Download the latest `fcx` binary from the GitHub releases page and add it to your `PATH`.

## Quick Start

```bash
# Install dependencies
bun install

# Build
bun run build

# Check version
bunx tsx cli/src/index.ts --version

# Check status
bunx tsx cli/src/index.ts status

# Run doctor
bunx tsx cli/src/index.ts doctor
```

## Binary

The binary is `fcx` (avoiding the `fc` shell built-in clash). It is exposed via:
- `cli/bin/fcx.js` (bun entry)
- `bin/fcx.js` (node entry)
- `homebrew/fcx.rb` (Homebrew formula)

## Commands

```
fcx [global flags] <command> [args]

Global flags:
  --output-format text|json
  --permission-mode MODE
  --model ggml/<id>
  --dry-run
  --no-escalate
  -C <path>

Commands:
  fix [file[:line]]     Fix diagnostic(s) in a file
  fix-test              Fix a failing test
  test | write-test     Write a test for a symbol
  implement             Implement a stub function
  types                 Add types to a symbol/file
  doc                   Write a docstring
  refactor              Refactor a selection
  rename [new-name]     Rename a symbol
  explain [question]    Explain code
  commit [--apply]      Generate a commit message
  ask [question]        Ask a routing question
  undo                  Undo the last task
  index [--rebuild] [--status]  Rebuild or show index status
  init                  Initialize fcx in a project
  models list|pull|bench  Manage models
  status                Show status
  doctor                Run health checks
  acp                   Start ACP server
```

## Development

```bash
bun install          # Install dependencies
bun run build        # Build all packages
bun run lint         # Run biome lint
bun run typecheck    # TypeScript typecheck
bun run test         # Run vitest tests
```

## Packages

- `cli/` — fcx binary and command dispatch
- `packages/config/` — Frontal Code config resolution, trust, policy
- `packages/model/` — ggml-node wrapper, model host, registry
- `packages/recipes/` — Recipe definitions and router
- `packages/retrieve/` — Hybrid retrieval
- `packages/index/` — Code graph index
- `packages/lsp/` — Language server pool
- `packages/defense/` — Six-layer hallucination defense
- `packages/verify/` — Per-language verifiers
- `packages/apply/` — Edit application, backups, undo
- `packages/memory/` — Local project memory
- `packages/escalate/` — Hosted model escalation
- `packages/acp/` — Agent Client Protocol server

## License

Apache-2.0
