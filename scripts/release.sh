#!/usr/bin/env bash
# scripts/release.sh - Release fcx packages via changesets
set -euo pipefail

echo "Releasing fcx packages..."
bun run ci:version
bun run release:publish

echo "Release complete."
