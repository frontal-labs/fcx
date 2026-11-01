#!/usr/bin/env bash
# scripts/eval.sh - Run fcx evaluation suite
set -euo pipefail

echo "Running fcx evals..."
bun run eval 2>/dev/null || {
  echo "eval script not wired yet. Running test suite instead."
  bun run test
}
