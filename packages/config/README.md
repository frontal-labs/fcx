# @fcx/config

Configuration resolution, trust checking, policy intersection, and permission mode resolution for fcx.

## Overview

`@fcx/config` handles all configuration loading and validation for the fcx agent. It resolves configuration from multiple sources, enforces trust policies, manages permission modes, and ensures safe operation through policy intersection.

## Features

- **Multi-source config resolution**: Loads from global and local config files with proper precedence
- **Trust checking**: Validates paths, repositories, and execution contexts for security
- **Policy intersection**: Combines global, project, and runtime policies
- **Permission modes**: Resolves and enforces permission modes (ask/allow/deny)
- **Project detection**: Identifies project roots, AGENTS.md files, and workspace configuration
- **Settings management**: Handles `fc.json`/`.frontal-code` settings with schema validation

## Installation

```bash
bun install
```

## API

```ts
import { resolveConfig, checkTrust, resolvePermissions } from "@fcx/config";
```

## Key Modules

- `resolve.ts` - Config resolution across global/local/project scopes
- `trust.ts` - Trust checking for files, paths, and repositories
- `policy.ts` - Policy definition and intersection logic
- `permissions.ts` - Permission mode resolution and enforcement
- `settings.ts` - Settings file loading and validation
- `project.ts` - Project root detection and metadata
- `paths.ts` - Path resolution utilities

## Dependencies

- `zod` ^4.1.5 - Schema validation

## License

Apache-2.0
