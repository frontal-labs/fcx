# Evaluations

## Task Format

```json
{
  "id": "ts-fix-diagnostic-001",
  "lang": "typescript",
  "recipe": "fix-diagnostic",
  "repo": { "url": "...", "commit": "..." },
  "setup": ["npm install"],
  "input": { "file": "src/x.ts", "line": 10 },
  "accepted": { "patch": "evals/patches/....diff" },
  "check": { "tests": ["npx vitest run -t TestX"] },
  "relevantFiles": ["src/x.ts"]
}
```

## Metrics

- Pass rate per recipe and language
- Exact/equivalent match against accepted patch (informational)
- Hallucination rate (candidates failing ground/cite)
- Retrieval recall (relevantFiles in context bundle)
- Abstention quality
- Latency (p50/p90), peak RSS

## Runner

```
bun run eval                 # all recipe tasks (evals/run-recipes.ts)
bun run eval --recipe commit-message
bun run eval --filter typo   # only tasks whose id contains the substring
bun run eval --out path.json # write the report somewhere else
bun evals/run.ts --filter x  # fix-diagnostic task set (evals/tasks/ts/fix-diagnostic-local)
```

Both runners load the local model (default `ggml/auto` → `qwen2.5-7b`), so the model must be
installed first: `bunx tsx cli/src/main.ts models pull qwen2.5-7b`.

## CI Gates

- Pass rate must not drop > 2 points on any language
- Hallucination rate must not rise > 1 point
- p50 latency must not rise > 15%
- Peak RSS within tier budget

## Current Tasks

89 TypeScript tasks in `evals/tasks/ts/*-local/` across 10 recipes (add-types, commit-message,
docstring, explain, fix-diagnostic, fix-test, implement, refactor-small, rename-extract,
write-test). The non-suffixed directories (add-types, docstring, fix-diagnostic, fix-test,
implement, write-test) hold repo-based task seeds for future public-repo runs.
