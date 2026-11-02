# @fcx/defense

Six-layer hallucination defense pipeline: constrain, ground, anchor, verify, cite, abstain.

## Overview

`@fcx/defense` implements fcx's core safety mechanism. Every edit and answer goes through a defense pipeline that prevents hallucinations, invalid edits, and ungrounded claims.

## Defense Layers

Applied in order (per PLAN.md §10):

1. **Constrain** - Schema validation against allow-lists (paths, symbols, packages). Ensures outputs match expected structure.
2. **Ground** - Every identifier must resolve to a real definition in the codebase/index.
3. **Anchor** - Each `search`/edit anchor must match exactly once in the target file.
4. **Verify** - LSP overlay checks followed by verifier plan execution (type checks, tests).
5. **Cite** (explain only) - Every claim must have ≥1 citation to actual code.
6. **Abstain** - If nothing passes after `maxCandidates`, return abstained rather than guessing.

## Features

- **EditSet validation**: Checks all proposed edits before application
- **Answer validation**: Validates explanations have proper citations
- **Configurable strictness**: Defense levels can be adjusted
- **Clear failure reasons**: Detailed diagnostics on defense failures

## Installation

```bash
bun install
```

## API

```ts
import { DefensePipeline, runDefense } from "@fcx/defense";
```

## Dependencies

- `@fcx/apply` - Edit application
- `@fcx/verify` - Verifier execution

## License

Apache-2.0
