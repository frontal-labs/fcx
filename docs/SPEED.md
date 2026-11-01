# Speed

fcx treats speed as a feature, not a polish item.

## Budgets (Tier S / Tier M)

| Metric | Tier S (8 GB) | Tier M (16 GB) |
|--------|---------------|----------------|
| `fcx --version`, `fcx status` (no model) | ≤ 60 ms p50 | ≤ 60 ms p50 |
| Socket round-trip (warm process) | ≤ 15 ms p50 | ≤ 15 ms p50 |
| Retrieval + context packing | ≤ 80 ms p50 | ≤ 80 ms p50 |
| Time to first candidate (fix-diagnostic) | ≤ 1.5 s p50 | ≤ 1.2 s p50 |
| LSP overlay check per candidate | ≤ 400 ms p50 | ≤ 400 ms p50 |
| Time to verified result (fix-diagnostic) | ≤ 4 s p50 | ≤ 3.5 s p50 |
| Model worker peak RSS | ≤ 1.8 GB | ≤ 2.5 GB |
| Index RSS during queries | ≤ 250 MB | ≤ 400 MB |

## Required Techniques

1. One bundled entry, lazy everything (dynamic `import()` per command)
2. Compile cache (`module.enableCompileCache()`)
3. Warm background process on `run/fc.sock` (unix socket, not TCP)
4. Overlap work (model load, LSP start, retrieval in parallel)
5. Short prompts, stable prefixes (byte-identical system blocks)
6. Short outputs (search/replace edits, never whole files)
7. Cheap checks first (anchor/ground before LSP overlays before tests)
8. Index ahead of time (hash check, not full scan)
9. Measure every stage (timings in JSON output and logs)

## Benchmarks

Run in CI on Linux. See `benchmarks/benchmarks.json`.
