#!/usr/bin/env bash
# scripts/test.sh - Run vitest tests
set -euo pipefail

echo "Running vitest tests..."
bun run test
