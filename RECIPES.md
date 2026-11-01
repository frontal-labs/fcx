# fcx Recipes

fcx implements 10 recipes. Detailed specs in [docs/RECIPES.md](./docs/RECIPES.md).

| ID | Command | Description |
|----|---------|-------------|
| fix-diagnostic | `fcx fix [file[:line]]` | Fix diagnostic(s) in a file |
| fix-test | `fcx fix-test` | Fix a failing test |
| write-test | `fcx test \| fcx write-test` | Write a unit test for a symbol |
| implement | `fcx implement` | Implement a stub function body |
| add-types | `fcx types` | Add type annotations (TS, Python) |
| docstring | `fcx doc` | Write a docstring |
| refactor-small | `fcx refactor` | Small refactor with instruction |
| rename-extract | `fcx rename [new-name]` | Rename a symbol |
| explain | `fcx explain [question]` | Explain code with citations |
| commit-message | `fcx commit [--apply]` | Conventional commit message |
| ask | `fcx ask [question]` | Route to a recipe |

## Additional Commands

- `fcx undo` — Undo the last task
- `fcx index [--rebuild] [--status]` — Rebuild or show index status
- `fcx init` — Initialize fcx in a project
- `fcx models list\|pull\|bench` — Manage models
- `fcx status` — Show status
- `fcx doctor` — Run health checks
- `fcx acp` — Start ACP server over stdio

## System Prompts

Each recipe's system prompt lives in `recipes/prompts/<recipe>.md` and is versioned.
