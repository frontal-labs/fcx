# Configuration

fcx shares configuration with Frontal Code. Resolution order:

1. `$FRONTAL_CODE_CONFIG_HOME` → `$FRONTAL_CODE_HOME` → `~/.frontal-code`
2. `project.json` lookup: config home, home, `~/.frontal-code`, `config/project.json`
3. Settings files: user → project → local (with trust filtering)
4. Permission mode: CLI flag → `RUSTY_CLAUDE_PERMISSION_MODE` → settings → `project.json` → default `prompt`

## Permission Modes

- `read-only` — Read only, no disk writes, no Bash
- `workspace-write` — Apply edits and run verifier commands in workspace
- `prompt` — Ask before edits and Bash commands (built-in default)
- `danger-full-access` — No prompts (never escalate without approval)

## Policy

- `allowedProviders` must include `"ggml"` for local model
- `allowedModels` applies to `ggml/` IDs
- `deny` uses Frontal Code tool names
- `permissionCeiling` caps the effective mode

## Local Settings (`fc` namespace)

Stored in `settings.json` under the `"fc"` key:
```json
{
  "fc": {
    "model": "ggml/auto",
    "embeddingModel": "ggml/bge-small-en-v1.5",
    "maxCandidates": "auto",
    "contextBudgetTokens": 3000,
    "languages": ["typescript", "python", "go", "rust"],
    "index": { "exclude": ["**/node_modules/**", ...] },
    "escalation": { "enabled": true, "provider": "default" },
    "telemetry": "inherit"
  }
}
```

## Parity Tests

30 fixture cases in `fixtures/config/cases/001-030/` covering all resolution branches.

## Packages

- `@frontal-labs/fcx-config` — `resolveConfig(cwd)` returns `ResolvedConfig`
