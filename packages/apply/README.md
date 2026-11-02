# @fcx/apply

Edit application system with search/replace diffs, automatic backups, undo support, and file permission handling.

## Overview

`@fcx/apply` safely applies EditSets produced by recipes to files. It creates backups before changes, validates anchors match exactly once, and supports undoing the last task.

## Features

- **Search/replace edits**: Precise, anchor-based edits
- **Backup creation**: Automatic backups before modifications
- **Undo support**: `fcx undo` restores previous state
- **Permission checking**: Respects file permissions and trust policies
- **Atomic application**: All edits in an EditSet applied together or rolled back
- **Anchor validation**: Ensures search strings match exactly once

## Installation

```bash
bun install
```

## API

```ts
import { applyEdits, undo, createBackup } from "@fcx/apply";
```

## EditSet Format

```ts
interface EditSet {
  edits: Array<{
    path: string;
    search: string;  // Must match exactly once
    replace: string;
  }>;
}
```

## Safety

- Anchors must match exactly once (enforced by defense)
- Backups stored for undo
- Respects permission modes and trust
- Path validation against allow-lists

## License

Apache-2.0
