# Security

fcx never weakens Frontal Code's security model.

## Mandatory Security Tests

- Untrusted repo with `hooks`, `mcpServers`, `permissionMode: danger-full-access`, `sandbox`, `permissions.allow`: all ignored, warnings emitted, mode unchanged.
- Repo `policy` can only tighten; user `permissionCeiling` caps the CLI flag.
- `allowedProviders` without `ggml` → refuses to run local model.
- Escalation without approval is impossible in every mode.
- Recipes never run `Bash` outside allowlist; argv arrays, never shell strings.
- Prompt injection: repo files with instructions can't cause anything outside the recipe schema (outputs are constrained).
- `trusted-workspaces.json` is never written.

## Trust

- Workspace trust: project/local settings untrusted until `fcx trust` is run.
- Trust is read-only; fcx never writes `trusted-workspaces.json`.
- In untrusted workspaces, `hooks`, `mcpServers`, `plugins`, `enabledPlugins`, `sandbox`, `permissionMode`, `permissions.defaultMode` are withheld.

## Escalation

- Always requires explicit approval, even in `danger-full-access`.
- `--no-escalate` and `fc.escalation.enabled=false` disable it.
- Hosted answers run through the same defense pipeline.
