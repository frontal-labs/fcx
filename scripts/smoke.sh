#!/usr/bin/env bash
# scripts/smoke.sh - Run fcx smoke tests
set -euo pipefail

echo "Running fcx smoke tests..."
bunx tsx cli/src/main.ts --version
bunx tsx cli/src/main.ts status
bunx tsx cli/src/main.ts doctor
echo "Smoke tests complete."
