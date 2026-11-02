# @fcx/retrieve

Hybrid retrieval system combining BM25, vector search, graph expansion, and context packing.

## Overview

`@fcx/retrieve` finds relevant code context for recipes by combining multiple retrieval strategies. It builds on the code index to gather definitions, call sites, types, and related symbols within token budgets.

## Features

- **BM25 search**: Full-text search over code symbols and content
- **Vector search**: Semantic similarity using embeddings
- **Graph expansion**: Traverses call graphs, type dependencies, and imports
- **Context packing**: Optimizes retrieved context to fit token budgets
- **Hybrid scoring**: Combines signals for better relevance

## Installation

```bash
bun install
```

## API

```ts
import { retrieve, HybridRetriever } from "@fcx/retrieve";
```

## Dependencies

- `@fcx/index` - Code graph index
- `@fcx/memory` - Local project memory

## How It Works

1. Query analysis extracts symbols, files, and intent
2. BM25 and vector search find initial candidates
3. Graph expansion follows references/dependencies
4. Results are scored and deduplicated
5. Context is packed within budget constraints

## License

Apache-2.0
