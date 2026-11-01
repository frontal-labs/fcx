#!/usr/bin/env bash
# scripts/bootstrap.sh - Bootstrap fcx project
set -euo pipefail

FCX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Bootstrapping fcx at $FCX_DIR..."

echo "Installing dependencies..."
bun install

echo "Setting up git hooks..."
bun run prepare

echo "Running initial typecheck..."
bun run typecheck

echo "Running initial tests..."
bun run test

echo ""
echo "Bootstrap complete. fcx is ready."
echo "Try: bunx tsx cli/src/index.ts --version"
