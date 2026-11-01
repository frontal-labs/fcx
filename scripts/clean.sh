#!/usr/bin/env bash
# scripts/clean.sh - Clean build artifacts
set -euo pipefail

FCX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Cleaning build artifacts..."
find "$FCX_DIR" -name "tsconfig.tsbuildinfo" -delete 2>/dev/null || true
find "$FCX_DIR/packages" -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
find "$FCX_DIR/cli" -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
echo "Cleaned."
