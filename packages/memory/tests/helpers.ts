import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as Sqlite from "node:sqlite";

export interface TempDir {
  path: string;
  file(relativePath: string, content: string): string;
  cleanup(): void;
}

export function makeTempDir(): TempDir {
  const path = mkdtempSync(join(tmpdir(), "fcx-memory-"));
  return {
    path,
    file(relativePath: string, content: string): string {
      const full = join(path, relativePath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf8");
      return full;
    },
    cleanup(): void {
      rmSync(path, { recursive: true, force: true });
    },
  };
}

/** Opens a raw SQLite handle for test setup. Loaded through createRequire, as the module does. */
export function openRawDatabase(path: string): Sqlite.DatabaseSync {
  const require = createRequire(import.meta.url);
  const sqlite = require("node:sqlite") as typeof Sqlite;
  return new sqlite.DatabaseSync(path);
}
