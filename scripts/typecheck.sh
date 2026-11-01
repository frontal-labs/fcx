#!/usr/bin/env bash
# scripts/typecheck.sh - Run TypeScript typecheck
set -euo pipefail

echo "Running TypeScript typecheck..."
bun run typecheck
