import { readFile } from "node:fs/promises";
import type { CheckTiming, LspClient } from "./client.js";
import { toDiagnostics } from "./client.js";
import { LspError } from "./errors.js";
import type { Diagnostic } from "./types.js";

/** File text on disk, or null when the file does not exist. Other errors propagate. */
export async function readDiskText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Check candidate texts in memory. The server gets the candidates with didOpen/didChange,
 * the check waits for publishDiagnostics for each file, and then every overlaid file is
 * sent its disk text again. Nothing is written to disk.
 *
 * Must run inside `client.exclusive`. Overlay files that do not exist on disk are closed on
 * the server instead of reverted to text.
 */
export async function runOverlayCheck(
  client: LspClient,
  target: string,
  overlays: ReadonlyMap<string, string>,
  timing: CheckTiming,
): Promise<Diagnostic[]> {
  const diskText = new Map<string, string | null>();
  for (const file of overlays.keys()) {
    diskText.set(file, await readDiskText(file));
  }

  const toCheck = new Map<string, string>(overlays);
  if (!toCheck.has(target)) {
    const text = await readDiskText(target);
    if (text === null) {
      throw new LspError("INVALID_ARGUMENT", `file does not exist: ${target}`, {
        language: client.language,
      });
    }
    toCheck.set(target, text);
  }

  try {
    // Every checkText call sends synchronously, so all files are in the server before any wait.
    const results = await Promise.all(
      [...toCheck].map(async ([file, text]) => ({
        file,
        raw: await client.checkText(file, text, timing),
      })),
    );
    return results.flatMap(({ file, raw }) => toDiagnostics(file, raw));
  } finally {
    for (const file of overlays.keys()) {
      await revert(client, file, diskText.get(file) ?? null, timing);
    }
  }
}

async function revert(
  client: LspClient,
  file: string,
  disk: string | null,
  timing: CheckTiming,
): Promise<void> {
  if (disk === null) {
    client.closeDocument(file);
    return;
  }
  try {
    // Send the disk state without waiting. Waiting would cost a full timeout for every clean state,
    // because a server that is clean publishes nothing. The next check only accepts publishes for its own version.
    client.syncText(file, disk);
  } catch {
    // Best effort. A failed revert leaves the server stale, and the next sync overwrites it.
  }
}
