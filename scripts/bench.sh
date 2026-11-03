#!/usr/bin/env bash
# scripts/bench.sh - Run fcx benchmarks
set -euo pipefail

echo "Running fcx benchmarks..."

echo "1. Version check (budget: 60ms)"
START=$(date +%s%N)
bunx tsx cli/src/main.ts --version > /dev/null
END=$(date +%s%N)
echo "   $(( (END - START) / 1000000 )) ms"

echo "2. Status check (budget: 60ms)"
START=$(date +%s%N)
bunx tsx cli/src/main.ts status > /dev/null
END=$(date +%s%N)
echo "   $(( (END - START) / 1000000 )) ms"

echo "3. Doctor check"
bunx tsx cli/src/main.ts doctor > /dev/null
echo "   done"

echo "Benchmarks complete."
