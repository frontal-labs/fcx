# fcx-verify

## Description

Skill for fcx per-language verifiers: TypeScript, Python, Go, Rust test and type check execution. Implements the `@frontal-labs/fcx-verify` package (now `fcx-verify`).

## Verifiers

| Language | Type Check | Test Command |
|----------|-----------|--------------|
| TypeScript | `tsc --noEmit` | `npx vitest run` |
| Python | `mypy` or `pyright` | `pytest` |
| Go | `go vet` | `go test ./...` |
| Rust | `cargo check` | `cargo test` |

## Verifier Plan

```ts
export interface VerifierPlan {
  commands: string[];
  cwd: string;
  timeoutMs: number;
  expectedPass: boolean;
}
```

## Files

- `packages/verify/src/` — Verifier implementations
- `docs/TESTING.md` — Testing spec

## License

Apache-2.0
