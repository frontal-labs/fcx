import { existsSync, readFileSync } from "node:fs";
import { UNSAFE_KEYS } from "./constants.js";
import { ConfigError } from "./errors.js";
import { errorMessage, isPlainObject } from "./util.js";

/** Returns undefined for a missing file, and throws on unreadable or malformed content. */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    const text = readFileSync(path, "utf-8");
    if (text.trim() === "") return undefined;
    value = parseJsonSafely(text);
  } catch (error) {
    throw new ConfigError(`${path}: invalid JSON: ${errorMessage(error)}`);
  }
  if (!isPlainObject(value)) {
    throw new ConfigError(`${path}: expected a JSON object`);
  }
  return value;
}

/** JSON.parse that drops prototype-reaching keys at every depth, so they never become live properties. */
export function parseJsonSafely(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) => (UNSAFE_KEYS.has(key) ? undefined : value));
}
