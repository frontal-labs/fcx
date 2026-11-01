#!/usr/bin/env bash
# scripts/fmt.sh - Format code with biome
set -euo pipefail

echo "Formatting code with biome..."
bun run lint --fix --unsafe

echo "Format complete."
