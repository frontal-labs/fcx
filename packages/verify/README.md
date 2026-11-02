# @fcx/verify

Per-language verifiers for TypeScript, Python, Go, and Rust - runs type checks and tests to validate changes.

## Overview

`@fcx/verify` executes language-specific verification commands after applying edits to ensure correctness. It integrates with the defense pipeline's verify layer.

## Features

- **Multi-language support**: TypeScript, Python, Go, Rust
- **Type checking**: Runs `tsc`, `mypy`/`pyright`, `go build`, `cargo check`
- **Test execution**: Runs relevant tests for changed code
- **Failure parsing**: Structured parsing of errors for feedback
- **Minimal execution**: Runs only necessary checks based on changes

## Installation

```bash
bun install
```

## API

```ts
import { VerifierPlan, runVerifier } from "@fcx/verify";
```

## Verifier Plans

Each recipe can specify a verifier plan defining:
- Commands to run
- Files/patterns to check
- Timeout limits
- Success criteria

## Usage

Verification runs as part of the defense pipeline after edits are applied to catch type errors, test failures, or other issues.

## License

Apache-2.0
