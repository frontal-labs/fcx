#!/usr/bin/env bash
# scripts/lint.sh - Run biome lint
set -euo pipefail

echo "Running biome lint..."
bun run lint
