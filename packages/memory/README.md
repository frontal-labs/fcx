# @fcx/memory

Local project memory for symbol tracking, context snapshots, and persistent storage.

## Overview

`@fcx/memory` maintains local, project-specific memory across sessions. It tracks symbol usage patterns, successful fixes, and provides context to improve future operations.

## Features

- **Symbol memory**: Tracks definitions, usages, and patterns
- **Context snapshots**: Saves relevant context from previous operations
- **Persistent storage**: Local SQLite storage per project
- **Privacy-first**: All data stays local, never uploaded
- **Recipe-aware**: Memory scoped to project and recipe types

## Installation

```bash
bun install
```

## API

```ts
import { MemoryStore, saveSymbol, recallContext } from "@fcx/memory";
```

## Storage

Memory is stored locally in the project (typically in `.frontal-code/memory/` or similar). It uses SQLite for efficient queries.

## Use Cases

- Remembering common patterns in the codebase
- Storing successful edit patterns
- Providing better context for similar tasks
- Reducing redundant retrieval

## License

Apache-2.0
