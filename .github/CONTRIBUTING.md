# Contributing to fcx

Thank you for your interest in contributing to fcx (Frontal Codex Extra Small)! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Submitting Changes](#submitting-changes)
- [Style Guidelines](#style-guidelines)
- [Testing](#testing)
- [License](#license)

## Code of Conduct

By participating in this project, you agree to abide by our Code of Conduct.

## Getting Started

1. Fork the repository on GitHub
2. Clone your fork: `git clone https://github.com/your-username/fcx.git`
3. Create a branch: `git checkout -b your-branch-name`
4. Make your changes
5. Push to your fork: `git push origin your-branch-name`
6. Open a pull request

## Development Setup

### Prerequisites

- Node.js >= 22 LTS
- Bun >= 1.1.0

### Install

```bash
bun install
bun run prepare
```

### Verify

```bash
bun run lint
bun run typecheck
bun run test
```

## Making Changes

### Branching

Create a descriptive branch name:
- `fix/fix-diagnostic-crash`
- `feat/add-new-recipe`
- `docs/update-config`

### Changesets

For package changes, add a changeset:

```bash
bunx changeset add
```

### Commits

Use conventional commits:
- `feat: add new recipe`
- `fix: resolve config parsing bug`
- `docs: update api reference`
- `chore: update dependencies`

## Submitting Changes

1. Ensure all checks pass: `bun run lint && bun run typecheck && bun run test`
2. Push your branch to your fork
3. Open a pull request against `main`
4. Fill out the pull request template
5. Address review feedback

## Style Guidelines

- TypeScript strict mode, ESM
- No `any` types
- Biome for formatting and linting
- Follow existing code patterns
- Add tests for new functionality
- Update documentation for user-facing changes

## Testing

```bash
# Run all tests
bun run test

# Run specific test file
bun run test -- packages/config/src/index.test.ts

# Run with coverage
bun run test -- --coverage
```

## License

Apache-2.0
