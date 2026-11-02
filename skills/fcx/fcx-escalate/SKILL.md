# @fcx/escalate

## Description

Skill for fcx hosted model escalation: approval-gated fallback to hosted models. Implements the `@fcx/escalate` package (now `fcx-escalate`).

## Escalation

- Always requires explicit approval, even in `danger-full-access`
- `--no-escalate` and `fc.escalation.enabled=false` disable it
- Hosted answers run through the same defense pipeline
- Provider configurable via `fc.escalation.provider`

## Files

- `packages/escalate/src/` — Escalation implementations
- `docs/SECURITY.md` — Escalation security rules

## License

Apache-2.0
