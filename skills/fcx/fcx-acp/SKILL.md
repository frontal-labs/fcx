# @fcx/acp

## Description

Skill for fcx Agent Client Protocol (V10) server over stdio. Implements the `@fcx/acp` package (now `fcx-acp`).

## Commands

- `fcx acp` — Start ACP server over stdio

## Implementation

- Map ACP prompts to `ask` recipe
- Expose recipes as commands/code actions
- Send edits through client's file-system and permission flows
- Stream progress: retrieval, candidate n of N, each check layer, result
- Create `run/fc.sock` (permissions 0600) for CLI reuse, remove on exit

## Testing

Tested against at least one real ACP-capable editor. Recorded in `DECISIONS.md`.

## Files

- `packages/acp/src/` — ACP server implementations
- `docs/ACP.md` — Full ACP spec

## License

Apache-2.0
