#!/usr/bin/env bash
# scripts/dev.sh - Development helper for fcx
set -euo pipefail

FCX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  echo "Usage: $0 {dev|build|lint|typecheck|test|doctor|status|fmt|clean|bootstrap|eval|smoke|release}"
  exit 1
}

cmd="${1:-}"
shift || true

case "$cmd" in
  dev)
    echo "Starting fcx in dev mode..."
    bunx tsx cli/src/index.ts "${@}"
    ;;
  build)
    echo "Building all packages..."
    bun run build
    ;;
  lint)
    echo "Running biome lint..."
    bun run lint
    ;;
  typecheck)
    echo "Running TypeScript typecheck..."
    bun run typecheck
    ;;
  test)
    echo "Running vitest tests..."
    bun run test
    ;;
  doctor)
    echo "Running fcx doctor..."
    bunx tsx cli/src/index.ts doctor
    ;;
  status)
    echo "Running fcx status..."
    bunx tsx cli/src/index.ts status
    ;;
  fmt)
    echo "Formatting with biome..."
    bun run lint --fix --unsafe
    ;;
  clean)
    echo "Cleaning build artifacts..."
    find "$FCX_DIR" -name "tsconfig.tsbuildinfo" -delete 2>/dev/null || true
    find "$FCX_DIR/packages" -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
    find "$FCX_DIR/cli" -name "dist" -type d -exec rm -rf {} + 2>/dev/null || true
    echo "Cleaned."
    ;;
  bootstrap)
    echo "Bootstrapping fcx..."
    bun install
    bun run prepare
    echo "Bootstrap complete."
    ;;
  eval)
    echo "Running evals..."
    bun run eval 2>/dev/null || echo "eval script not yet wired"
    ;;
  smoke)
    echo "Running smoke tests..."
    bunx tsx cli/src/index.ts --version
    bunx tsx cli/src/index.ts status
    bunx tsx cli/src/index.ts doctor
    ;;
  release)
    echo "Running release..."
    bun run ci:version
    bun run release:publish
    ;;
  *)
    usage
    ;;
esac
