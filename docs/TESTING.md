# Testing

## Unit Tests

Next to the code, vitest. Cover:
- Config resolution branches
- Policy intersection
- Schema builders
- Each defense layer (pass and fail)
- Anchor matching edge cases (CRLF, tabs, Unicode)
- RRF math, graph expansion, context packing
- Verifier command construction per package manager

## Integration Tests

`fixtures/repos/*` — tiny repos with known errors and tests. Run every recipe with `MockModelHost` (recorded good/bad outputs) and with real baseline model (nightly).

## Security Tests

See `docs/SECURITY.md`.

## Hallucination Suite

Mock model that deliberately returns:
- Nonexistent paths (rejected by schema)
- Made-up identifiers and dependency members
- Anchors matching zero or several times
- Edits that don't compile
- Explanations with false citations

Expect 100% detection with correct `reasonCode`s.

## CI

- Smoke set (20 tasks, mock + real model) on every PR
- Full set nightly and on release branches
