# fcx-apply

## Description

Skill for fcx edit application: search/replace diffs, backups, undo, and file permissions. Implements the `@frontal-labs/fcx-apply` package (now `fcx-apply`).

## Commands

- `fcx undo` — Undo the last task

## Apply Contract

- Search/replace edits anchored to exact single match
- Backups stored before mutation
- Undo restores from backup
- File permissions respected (read-only files rejected)

## Files

- `packages/apply/src/` — Apply implementations
- `docs/RECIPES.md` — Recipe apply contract

## License

Apache-2.0
