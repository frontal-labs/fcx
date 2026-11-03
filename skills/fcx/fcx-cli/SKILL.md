# @fcx/cli

## Description

Skill for fcx CLI binary and command dispatch layer. Implements the `fcx-cli` package.

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

## Entry Points

- `cli/bin/fcx.js` — Bun entry (primary)
- `bin/index.js` — Node entry (fallback)
- `homebrew/fcx.rb` — Homebrew formula

## Binary

Named `fcx` (avoids `fc` shell built-in clash).

## Files

- `cli/src/main.ts` — Command dispatch table
- `cli/src/meta.ts` — Binary/package metadata
- `cli/src/commands/*.ts` — 17 command handler files

## License

Apache-2.0
