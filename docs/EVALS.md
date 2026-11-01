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
bun run eval --lang typescript --recipe fix-diagnostic --model ggml/qwen2.5-1.5b
```

## CI Gates

- Pass rate must not drop > 2 points on any language
- Hallucination rate must not rise > 1 point
- p50 latency must not rise > 15%
- Peak RSS within tier budget

## Current Tasks

20 TypeScript tasks in `evals/tasks/ts/` across 6 recipes.
