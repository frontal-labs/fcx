# @fcx/lsp

Language server pool managing per-language LSP clients using vscode-jsonrpc.

## Overview

`@fcx/lsp` provides access to Language Server Protocol features like diagnostics, go-to-definition, find-references, hover, and code actions. It manages a pool of language servers with lifecycle management.

## Features

- **Multi-language support**: TypeScript, Python, Go, Rust, etc.
- **Client pooling**: Efficient reuse of LSP connections
- **JSON-RPC transport**: Uses `vscode-jsonrpc` for communication
- **Diagnostics integration**: Powers `fix` command with LSP diagnostics
- **Graceful lifecycle**: Start, stop, and restart language servers

## Installation

```bash
bun install
```

## API

```ts
import { LspPool, getDiagnostics, findReferences } from "@fcx/lsp";
```

## Dependencies

- `vscode-jsonrpc` ^8.2.0
- `vscode-languageserver-protocol` ^3.17.5
- `vscode-languageserver-types` ^3.17.5

## Usage

The LSP pool is used by recipes to get accurate symbol information and diagnostics for verification.

## License

Apache-2.0
