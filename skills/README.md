# fcx Skills

Skill definitions for the fcx local coding agent. Managed via `skills/skills.sh`.

## Internal fcx Skills

| Skill | Path | Description |
|-------|------|-------------|
| fcx-config | `skills/fcx/fcx-config/SKILL.md` | Config resolution, trust, policy, permission modes |
| fcx-model | `skills/fcx/fcx-model/SKILL.md` | ggml-node wrapper, model registry, ModelHost |
| fcx-recipes | `skills/fcx/fcx-recipes/SKILL.md` | Recipe router and 10 coding recipes |
| fcx-defense | `skills/fcx/fcx-defense/SKILL.md` | Six-layer defense pipeline |
| fcx-index | `skills/fcx/fcx-index/SKILL.md` | Tree-sitter indexing, SQLite store |
| fcx-retrieve | `skills/fcx/fcx-retrieve/SKILL.md` | Hybrid retrieval: BM25, vectors, graph |
| fcx-verify | `skills/fcx/fcx-verify/SKILL.md` | Per-language verifiers |
| fcx-apply | `skills/fcx/fcx-apply/SKILL.md` | Edit application, backups, undo |
| fcx-memory | `skills/fcx/fcx-memory/SKILL.md` | Local project memory |
| fcx-escalate | `skills/fcx/fcx-escalate/SKILL.md` | Hosted model escalation |
| fcx-acp | `skills/fcx/fcx-acp/SKILL.md` | Agent Client Protocol server |
| fcx-cli | `skills/fcx/fcx-cli/SKILL.md` | CLI binary and command dispatch |

## External Skills

Referenced in `skills-lock.json`:
- ai-sdk, drizzle, github-actions-templates, mcp-builder, playwright-cli
- posthog-instrumentation, stripe-best-practices, turborepo, ultracite, vitest, zod

## Usage

```bash
# List all skills
./skills/skills.sh list

# Show a skill
./skills/skills.sh show fcx-config

# Add a new skill
./skills/skills.sh add my-skill

# Remove a skill
./skills/skills.sh remove my-skill
```

## License

Apache-2.0
