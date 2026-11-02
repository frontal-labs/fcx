import { extname } from "node:path";
import type { VerifyLanguage } from "./verify-types.js";

const TYPESCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Maps a file path to the verifier that handles it. */
export function languageForPath(file: string): VerifyLanguage {
  const ext = extname(file).toLowerCase();
  if (ext === ".go") return "go";
  if (ext === ".py") return "python";
  if (ext === ".rs") return "rust";
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return "typescript";
  return "unknown";
}
