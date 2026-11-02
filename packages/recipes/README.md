# @fcx/recipes

Recipe router and 10 coding task recipes for fcx.

## Overview

`@fcx/recipes` defines the task execution framework. Each recipe is a self-contained unit that knows how to gather context, construct prompts, parse structured outputs, apply edits, run defense checks, and verify results.

## Features

- **Recipe router**: Routes natural language tasks to appropriate recipes
- **10 built-in recipes**: Cover common coding operations
- **Structured output**: All recipes produce typed, schema-validated outputs
- **Defense integration**: Built-in checks for each recipe
- **Prompt-prefix caching**: Byte-stable system prompts across calls

## Recipes

| Recipe | Command | Description |
|--------|---------|-------------|
| `fix-diagnostic` | `fcx fix` | Fix LSP diagnostics at a file:line location |
| `fix-test` | `fcx fix-test` | Fix a failing test to make it pass |
| `write-test` | `fcx write-test`/`test` | Write a unit test for a symbol |
| `implement` | `fcx implement` | Implement a stub function body |
| `add-types` | `fcx types` | Add type annotations to symbols/files |
| `docstring` | `fcx doc` | Write documentation comments |
| `refactor-small` | `fcx refactor` | Small, focused refactoring |
| `rename-extract` | `fcx rename` | Rename a symbol across references |
| `explain` | `fcx explain` | Explain code with citations |
| `commit-message` | `fcx commit` | Generate conventional commit messages |

## API

```ts
import { Router, getRecipe } from "@fcx/recipes";
```

## Architecture

Each recipe implements:
- `describe` - Human-readable description
- `needs` - Required tools/services
- `gather()` - Context collection
- `schema()` - Zod schema for output
- `prompt()` - System/user prompt construction
- `toEdits()` - Convert output to edit set or answer
- `checks` - Defense layers to apply
- `verifier()` - Verification plan

## License

Apache-2.0
