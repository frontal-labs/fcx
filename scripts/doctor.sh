#!/usr/bin/env bash
# scripts/doctor.sh - Run fcx doctor health checks
set -euo pipefail

echo "Running fcx doctor..."
bunx tsx cli/src/index.ts doctor
