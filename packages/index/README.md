# @fcx/index

Code graph index using TypeScript compiler API extraction, SQLite (node:sqlite) storage with FTS5, and incremental indexing.

## Overview

`@fcx/index` builds and maintains a queryable code graph of the project. It extracts symbols, definitions, references, types, and relationships using the TypeScript compiler API, storing them in SQLite with full-text search support.

## Features

- **TS compiler API extraction**: Deep AST analysis for TypeScript/JavaScript
- **SQLite storage**: Uses Node.js built-in `node:sqlite` with FTS5
- **Incremental indexing**: Only reindexes changed files
- **Symbol graph**: Tracks definitions, references, and relationships
- **Fast queries**: Optimized for recipe context gathering

## Installation

```bash
bun install
```

## API

```ts
import { IndexStore, buildIndex, queryIndex } from "@fcx/index";
```

## Key Capabilities

- Symbol lookup by name and kind
- Find all references to a symbol
- Get definition locations
- Traverse call/type/import graphs
- Full-text search across symbols and code

## Dependencies

- `@fcx/config` - Project configuration
- `typescript` ^5.6.0 - Compiler API

## License

Apache-2.0
