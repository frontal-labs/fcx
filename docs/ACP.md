# ACP

Agent Client Protocol (V10) over stdio.

## Implementation

- Map ACP prompts to `ask` recipe
- Expose recipes as commands/code actions
- Send edits through client's file-system and permission flows
- Stream progress: retrieval, candidate n of N, each check layer, result
- Keep model, index, LSP warm
- Create `run/fc.sock` (permissions 0600) for CLI reuse, remove on exit

## Testing

Tested against at least one real ACP-capable editor. Recorded in `DECISIONS.md`.

## Entry Point

`fcx acp` — starts the ACP server over stdio.
