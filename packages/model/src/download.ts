import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ModelFile, ModelRegistryEntry } from "./types.js";

export type FileState = "installed" | "partial" | "missing";

/** A file is installed when it exists at its exact size. Anything else is downloaded again. */
export async function fileState(dir: string, file: ModelFile): Promise<FileState> {
  try {
    const info = await stat(join(dir, file.name));
    if (info.size === file.bytes) return "installed";
    return "partial";
  } catch {
    return "missing";
  }
}

/** Installed when every file of the entry is installed. Entries without files are not downloadable here. */
export async function entryState(dir: string, entry: ModelRegistryEntry): Promise<FileState> {
  if (entry.files === undefined || entry.files.length === 0) return "missing";
  let worst: FileState = "installed";
  for (const file of entry.files) {
    const state = await fileState(dir, file);
    if (state === "missing") return "missing";
    if (state === "partial") worst = "partial";
  }
  return worst;
}

export interface DownloadProgress {
  file: string;
  received: number;
  total: number;
}

/**
 * Downloads each missing or partial file of the entry into `dir`. Files are written to `<name>.partial` and renamed when
 * complete, so an interrupted download never looks installed. A file whose size does not match is an error.
 */
export async function downloadEntry(
  dir: string,
  entry: ModelRegistryEntry,
  onProgress?: (p: DownloadProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{ downloaded: string[]; skipped: string[] }> {
  if (entry.files === undefined || entry.files.length === 0) {
    throw new Error(`${entry.id} is not a downloadable model`);
  }
  await mkdir(dir, { recursive: true });
  const downloaded: string[] = [];
  const skipped: string[] = [];
  for (const file of entry.files) {
    if ((await fileState(dir, file)) === "installed") {
      skipped.push(file.name);
      continue;
    }
    const response = await fetchImpl(file.url);
    if (!response.ok || response.body === null) {
      throw new Error(`download failed for ${file.name}: HTTP ${response.status}`);
    }
    const target = join(dir, file.name);
    const partial = `${target}.partial`;
    let received = 0;
    const counter = async function* (source: AsyncIterable<Uint8Array>) {
      for await (const chunk of source) {
        received += chunk.byteLength;
        onProgress?.({ file: file.name, received, total: file.bytes });
        yield chunk;
      }
    };
    await pipeline(
      Readable.from(counter(Readable.fromWeb(response.body as never))),
      createWriteStream(partial),
    );
    const size = (await stat(partial)).size;
    if (size !== file.bytes) {
      await rm(partial, { force: true });
      throw new Error(`${file.name} is ${size} bytes, expected ${file.bytes}`);
    }
    await rename(partial, target);
    downloaded.push(file.name);
  }
  return { downloaded, skipped };
}
