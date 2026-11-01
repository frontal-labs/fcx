# Recipes

fcx implements 10 recipes. Each recipe has a system prompt in `recipes/prompts/`.

## Recipe List

| ID | Trigger | Description |
|----|---------|-------------|
| fix-diagnostic | Diagnostic at file:line | Fix diagnostic errors |
| fix-test | Failing test name | Fix a failing test |
| write-test | Symbol | Write a unit test |
| implement | Stub/signature | Implement a function body |
| add-types | Symbol/file (TS, Python) | Add type annotations |
| docstring | Symbol | Write a docstring |
| refactor-small | Selection + instruction | Small refactor |
| rename-extract | Symbol/selection | Rename a symbol |
| explain | Selection/question | Explain with citations |
| commit-message | Staged diff | Conventional commit message |

## Recipe Contract

```ts
export interface Recipe {
  id: RecipeId;
  describe: string;
  needs: ToolName[];
  gather(task, ctx): Promise;
  schema(bundle): z.ZodType;
  prompt(bundle): { system: string; user: string };
  toEdits(out, bundle): EditSet \| Answer;
  checks: DefenseLayer[];
  verifier(bundle): VerifierPlan;
}
```

## Router

If the trigger names a recipe, skip the router. Otherwise, use `generateObject` with a recipe enum schema to select the recipe, or return `"unsupported"` with an escalation offer.

## Defense Layers

1. **Constrain** — Schemas from allow-lists (paths, symbols, packages)
2. **Ground** — Every identifier must resolve to a definition
3. **Anchor** — Each search matches exactly once
4. **Verify** — LSP overlay + test commands
5. **Cite** (explain only) — Every claim needs a citation
6. **Abstain** — Return abstained if nothing passes
