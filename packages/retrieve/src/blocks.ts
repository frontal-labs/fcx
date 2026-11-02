import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SymbolRecord } from "@fcx/index";
import { SIGNATURE_MIN_HOPS } from "./constants.js";

export interface BlockText {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
}

/**
 * Text for a symbol block (plan section 8.3, step 6). Nodes reached `SIGNATURE_MIN_HOPS` or more
 * hops away give only the signature, on the symbol's header line. Nearer nodes give the full body.
 */
export function symbolBlockText(
  symbol: SymbolRecord,
  lines: readonly string[],
  hops: number,
): BlockText {
  const body = lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
  if (hops >= SIGNATURE_MIN_HOPS) {
    const signature = symbol.signature.trim();
    const firstLine = body.split("\n")[0]?.trim() ?? "";
    return {
      text: signature.length > 0 ? signature : firstLine,
      startLine: symbol.startLine,
      endLine: symbol.startLine,
    };
  }
  return { text: body, startLine: symbol.startLine, endLine: symbol.endLine };
}

/** Reads workspace files once per retrieval. Unreadable files are remembered as undefined. */
export class SourceCache {
  readonly #workspace: string;
  readonly #lines = new Map<string, Promise<string[] | undefined>>();

  constructor(workspace: string) {
    this.#workspace = workspace;
  }

  lines(relativePath: string): Promise<string[] | undefined> {
    let cached = this.#lines.get(relativePath);
    if (cached === undefined) {
      cached = readFile(join(this.#workspace, relativePath), "utf8").then(
        (text) => text.split(/\r?\n/),
        () => undefined,
      );
      this.#lines.set(relativePath, cached);
    }
    return cached;
  }
}
