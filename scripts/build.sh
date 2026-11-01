#!/usr/bin/env bash
# scripts/build.sh - Build all fcx packages
set -euo pipefail

echo "Building fcx packages..."
bun run build

echo ""
echo "Build complete. Output in dist/ directories."
echo "CLI entry: cli/bin/fcx.js"
