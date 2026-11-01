# fcx Prompts

System prompts for fcx recipes. Each prompt file is versioned with `promptVersion` in its header.
Changing a prompt requires bumping `promptVersion` and an eval run attached to the PR.

Prompt files are byte-stable across calls so the prompt-prefix (KV) cache is reused.

## Prompt Files

| File | Recipe | Description |
|------|--------|-------------|
| `router.md` | Router | Routes free-form tasks to recipes or "unsupported" |
| `fix-diagnostic.md` | fix-diagnostic | Fix diagnostic errors at file:line |
| `fix-test.md` | fix-test | Fix a failing test |
| `write-test.md` | write-test | Write a unit test for a symbol |
| `implement.md` | implement | Implement a stub function body |
| `add-types.md` | add-types | Add type annotations (TS, Python) |
| `docstring.md` | docstring | Write a docstring for a symbol |
| `refactor-small.md` | refactor-small | Small refactor with instruction |
| `rename-extract.md` | rename-extract | Rename a symbol |
| `explain.md` | explain | Explain code with citations |
| `commit-message.md` | commit-message | Conventional commit message |
| `user-instruction-block.md` | All | AGENTS.md + skills block injected into user prompts |

## Prompt Contract (per PLAN.md §9.2)

```ts
export interface Recipe {
  id: RecipeId;
  describe: string;
  needs: ToolName[];
  gather(task: Task, ctx: Services): Promise;
  schema(bundle: ContextBundle): z.ZodType;
  prompt(bundle: ContextBundle): { system: string; user: string }; // system byte-stable
  toEdits(out: O, bundle: ContextBundle): EditSet | Answer;
  checks: DefenseLayer[];
  verifier(bundle: ContextBundle): VerifierPlan;
}
```

## Defense Layers (applied in order, per PLAN.md §10)

1. **Constrain** — Schemas from allow-lists (paths, symbols, packages)
2. **Ground** — Every identifier resolves to a definition
3. **Anchor** — Each `search` matches exactly once in the file
4. **Verify** — LSP overlay, then verifier plan (test commands)
5. **Cite** (explain only) — Every claim needs ≥1 citation
6. **Abstain** — Return abstained if nothing passes after `maxCandidates`

## Prompt-Prefix Caching (PLAN.md §6.1, §15.2)

Every recipe system prompt must be byte-identical across calls so ggml-node's
prompt-prefix (KV) cache is reused. No timestamps, no varying whitespace.

## User Instruction Block

`user-instruction-block.md` is injected into every recipe's user prompt. It
contains:
- `AGENTS.md` from repo root and nested paths (≤300 tokens, trimmed by heading priority)
- Skills from `.frontal-code/skills` (v1: conventions text only)

## License

Apache-2.0
