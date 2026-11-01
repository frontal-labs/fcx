#!/usr/bin/env bash
# scripts/status.sh - Run fcx status
set -euo pipefail

echo "Running fcx status..."
bunx tsx cli/src/index.ts status
