# @fcx/recipes

## Description

Skill for fcx recipes: router and 10 coding recipes. Implements the `@fcx/recipes` package (now `fcx-recipes`).

## Commands

- `fcx fix [file[:line]]` — fix-diagnostic recipe
- `fcx fix-test` — fix-test recipe
- `fcx test | fcx write-test` — write-test recipe
- `fcx implement` — implement recipe
- `fcx types` — add-types recipe
- `fcx doc` — docstring recipe
- `fcx refactor` — refactor-small recipe
- `fcx rename [new-name]` — rename-extract recipe
- `fcx explain [question]` — explain recipe
- `fcx commit [--apply]` — commit-message recipe
- `fcx ask [question]` — ask recipe (router)

## Recipe List

| ID | Trigger | Description |
|----|---------|-------------|
| fix-diagnostic | Diagnostic at file:line | Fix diagnostic errors |
| fix-test | Failing test name | Fix a failing test |
| write-test | Symbol | Write a unit test |
| implement | Stub/signature | Implement function body |
| add-types | Symbol/file | Add type annotations |
| docstring | Symbol | Write a docstring |
| refactor-small | Selection + instruction | Small refactor |
| rename-extract | Symbol/selection | Rename symbol |
| explain | Selection/question | Explain with citations |
| commit-message | Staged diff | Conventional commit |
| ask | Question | Route to recipe |

## Recipe Contract

```ts
export interface Recipe {
  id: RecipeId;
  describe: string;
  needs: ToolName[];
  gather(task, ctx): Promise;
  schema(bundle): z.ZodType;
  prompt(bundle): { system: string; user: string };
  toEdits(out, bundle): EditSet | Answer;
  checks: DefenseLayer[];
  verifier(bundle): VerifierPlan;
}
```

## Files

- `packages/recipes/src/` — Recipe implementations
- `recipes/prompts/*.md` — Recipe system prompts
- `schemas/recipe-output.schema.json` — Output schema

## License

Apache-2.0
