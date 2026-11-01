# fcx-defense

## Description

Skill for fcx defense pipeline: six layers that constrain, ground, anchor, verify, cite, and abstain. Implements the `@frontal-labs/fcx-defense` package (now `fcx-defense`).

## Defense Layers (in order)

1. **Constrain** — Build schemas from allow-lists; made-up paths cannot be expressed
2. **Ground** — Every referenced identifier must resolve to a definition
3. **Anchor** — Each `search` must match exactly once in the current file
4. **Verify** — LSP overlay diagnostics first, then verifier plan (test commands)
5. **Cite** (`explain` only) — Every claim needs ≥1 citation; range must exist
6. **Abstain** — Return `Abstained` if nothing passes after `maxCandidates`

## Candidate Generation

Temperatures: `[0.2, 0.5, 0.7, 0.9, 1.0, 1.0]`, truncated to `maxCandidates`. Stop at first passing candidate.

## Logging

Every layer outcome logged to `logs/fc/defense.jsonl`:
`{ task, recipe, layer, pass, reasonCode, ms }`

## Files

- `packages/defense/src/` — Defense layer implementations
- `docs/DEFENSE.md` — Full defense pipeline spec

## License

Apache-2.0
