# Defense Pipeline

Six-layer defense pipeline. Each layer is a function `(candidate, bundle) => Pass \| Fail{ reason, feedback }`.

## Layers (in order)

1. **Constrain** — Build schemas from allow-lists. Made-up paths cannot be expressed.
2. **Ground** — Parse replacement code, extract every referenced identifier. Each must resolve to a local definition, in-scope symbol, dependency API, or language builtin.
3. **Anchor** — Each `search` must match exactly once in the current file (after line-ending normalization).
4. **Verify** — Language-server overlay diagnostics first, then verifier plan (test commands).
5. **Cite** (`explain` only) — Every claim needs ≥1 citation; citation range must exist.
6. **Abstain** — If nothing passes after `maxCandidates`, return `Abstained`.

## Candidate Generation

Temperatures: `[0.2, 0.5, 0.7, 0.9, 1.0, 1.0]`, truncated to `maxCandidates`. Stop at first passing candidate.

## Logging

Every layer outcome logged to `logs/fc/defense.jsonl`:
`{ task, recipe, layer, pass, reasonCode, ms }`
