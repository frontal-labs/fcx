---
"@fcx/cli": patch
---

Add an `eval` script to the root package that runs the recipe eval harness, so `bun run eval` (used by the Evals workflow and scripts/eval.sh) resolves to the real entrypoint instead of failing.
