# @fcx/cli

fcx CLI binary and command dispatch layer.

## Overview

The CLI package provides the `fcx` command-line interface - argument parsing, command routing, service wiring, and output formatting. It orchestrates all packages to deliver the complete fcx experience.

## Features

- **Command dispatch**: Routes commands to appropriate handlers
- **Service initialization**: Wires up config, model, index, LSP, etc.
- **Output formatting**: Text and JSON output modes
- **Permission modes**: Respects trust and permission settings
- **Warm process**: Unix socket for fast repeated invocations
- **Binary entry points**: Multiple entry points for different runtimes

## Installation

```bash
bun install
```

## Commands

See root README for full command list. Key commands:
- `fcx fix` - Fix diagnostics
- `fcx fix-test`, `fcx write-test` - Test operations
- `fcx implement`, `fcx types`, `fcx doc` - Code generation
- `fcx refactor`, `fcx rename` - Refactoring
- `fcx explain` - Code explanation
- `fcx commit` - Commit messages
- `fcx ask` - Router questions
- `fcx index` - Manage code index
- `fcx models` - Model management
- `fcx status`, `fcx doctor` - Diagnostics
- `fcx acp` - ACP server

## Dependencies

### Internal
- `@fcx/acp`, `@fcx/apply`, `@fcx/config`, `@fcx/defense`
- `@fcx/escalate`, `@fcx/index`, `@fcx/lsp`, `@fcx/memory`
- `@fcx/model`, `@fcx/recipes`, `@fcx/retrieve`, `@fcx/verify`

### External
- `typescript` ^5.6.0
- `zod` ^4.1.5

## Scripts

- `build` - Build with tsup
- `test` - Run tests with vitest
- `lint` - Lint with biome

## Binary

Entry points:
- `cli/bin/fcx.js` (bun)
- `bin/fcx.js` (node)
- `homebrew/fcx.rb` (Homebrew formula)

## License

Apache-2.0
