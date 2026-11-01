#!/usr/bin/env bash
# scripts/smoke.sh - Run fcx smoke tests
set -euo pipefail

echo "Running fcx smoke tests..."
bunx tsx cli/src/index.ts --version
bunx tsx cli/src/index.ts status
bunx tsx cli/src/index.ts doctor
echo "Smoke tests complete."
