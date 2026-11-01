# fcx-config

## Description

Skill for fcx configuration resolution, trust checking, policy intersection, and permission mode resolution. Implements the `@frontal-labs/fcx-config` package (now `fcx-config`).

## Commands

- `fcx status` — Show resolved configuration status
- `fcx doctor` — Run health checks on config, trust, and policy
- `fcx init` — Initialize fcx in a project (writes `.frontal-code/settings.json`)

## Configuration

Resolved from:
1. `$FRONTAL_CODE_CONFIG_HOME` → `$FRONTAL_CODE_HOME` → `~/.frontal-code`
2. `project.json` lookup in config home, home, `~/.frontal-code`, `config/project.json`
3. Settings files merged user → project → local (trust-filtered)
4. Permission mode: CLI flag → env → settings → `project.json` → default `prompt`

## Local Settings (`fc` namespace)

Stored under the `"fc"` key in settings:
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

## Permission Modes

- `read-only` — Read only, no disk writes, no Bash
- `workspace-write` — Apply edits and run verifier commands
- `prompt` — Ask before edits and Bash (built-in default)
- `danger-full-access` — No prompts

## Files

- `packages/config/src/index.ts` — `resolveConfig(cwd)`, `FcError`, `ConfigError`, types
- `fixtures/config/cases/001-030/` — 30 config parity fixture cases

## License

Apache-2.0
