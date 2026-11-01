#!/usr/bin/env bash
# skills.sh - fcx skills management
# Manages skill definitions for the fcx local coding agent.
#
# Usage:
#   skills.sh list              List available skills
#   skills.sh show <name>       Show a skill definition
#   skills.sh add <name>        Add a new skill
#   skills.sh remove <name>     Remove a skill

set -euo pipefail

FCX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKILLS_DIR="$FCX_DIR/skills"

usage() {
  echo "Usage: $0 {list|show|add|remove} [name]"
  exit 1
}

cmd="${1:-}"
shift || true

case "$cmd" in
  list)
    echo "Available skills in $SKILLS_DIR:"
    if [ -d "$SKILLS_DIR" ]; then
      for f in "$SKILLS_DIR"/*.md; do
        [ -e "$f" ] || continue
        echo "  - $(basename "$f" .md)"
      done
    else
      echo "  (none)"
    fi
    ;;
  show)
    name="${1:-}"
    [ -n "$name" ] || usage
    f="$SKILLS_DIR/$name.md"
    if [ -f "$f" ]; then
      cat "$f"
    else
      echo "Skill not found: $name"
      exit 1
    fi
    ;;
  add)
    name="${1:-}"
    [ -n "$name" ] || usage
    f="$SKILLS_DIR/$name.md"
    if [ -f "$f" ]; then
      echo "Skill already exists: $name"
      exit 1
    fi
    cat > "$f" <<EOF
# $name

## Description

## Commands

## Configuration

## Examples
EOF
    echo "Added skill: $name"
    ;;
  remove)
    name="${1:-}"
    [ -n "$name" ] || usage
    f="$SKILLS_DIR/$name.md"
    if [ -f "$f" ]; then
      rm "$f"
      echo "Removed skill: $name"
    else
      echo "Skill not found: $name"
      exit 1
    fi
    ;;
  *)
    usage
    ;;
esac
