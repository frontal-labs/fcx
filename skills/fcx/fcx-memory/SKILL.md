# @fcx/memory

## Description

Skill for fcx local project memory: symbol memory, context snapshots, and persistent storage. Implements the `@fcx/memory` package (now `fcx-memory`).

## Memory Store

- `memory` table: symbol_id, file_id, kind, text, source, created_at
- Persisted alongside index in SQLite
- Survives across sessions

## Files

- `packages/memory/src/` — Memory implementations
- `docs/ARCHITECTURE.md` — Cross-cutting memory layer

## License

Apache-2.0
