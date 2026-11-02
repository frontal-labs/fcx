import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as Sqlite from "node:sqlite";
import { MemoryError } from "./errors";
import { MAX_TEXT_LENGTH, insertRecord } from "./records";
import { detectSecret } from "./redact";
import { DEFAULT_BUDGET_TOKENS } from "./retrieve";
import { approximateTokens } from "./tokens";
import type { ImportResult, InstructionBlock } from "./types";

const AGENTS_FILE = "AGENTS.md";
const PRIORITY_PATTERN = /build|test|lint|typecheck/i;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"]);

export interface MarkdownSection {
  heading: string | null;
  text: string;
}

/**
 * Splits Markdown into sections. A section starts at an ATX heading (outside code fences) and
 * runs to the next heading. Sections without body text are dropped. Output is deterministic.
 */
export function parseSections(markdown: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const sections: { heading: string | null; lines: string[] }[] = [];
  let current: { heading: string | null; lines: string[] } = { heading: null, lines: [] };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.lines.push(line);
      continue;
    }
    const match = inFence ? null : /^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (match) {
      sections.push(current);
      current = { heading: match[1] ?? null, lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  const result: MarkdownSection[] = [];
  for (const section of sections) {
    const body = section.heading === null ? section.lines : section.lines.slice(1);
    if (body.join("").trim() === "") {
      continue;
    }
    result.push({
      heading: section.heading,
      text: section.lines.join("\n").replace(/\s+$/, ""),
    });
  }
  return result;
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/** Repo-relative target path, using "/" separators. Rejects paths outside the root. */
function repoRelative(root: string, targetFile: string): string {
  const absoluteRoot = resolve(root);
  const rel = isAbsolute(targetFile)
    ? relative(absoluteRoot, targetFile)
    : relative(absoluteRoot, resolve(absoluteRoot, targetFile));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MemoryError("invalid_path", `target file is outside the repository: ${targetFile}`);
  }
  return rel.split(sep).join("/");
}

function checkBudget(budgetTokens: number): void {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 0) {
    throw new MemoryError("invalid_budget", "token budget must be a non-negative integer");
  }
}

/**
 * Reads AGENTS.md at the root and in every directory on the path to targetFile, then builds an
 * instruction block of at most budgetTokens. Sections whose heading contains build, test, lint or
 * typecheck are taken first; the rest follow in document order. Sections that do not fit are
 * skipped. The chosen sections are printed in document order. Sections containing secrets are
 * never included.
 */
export function projectInstructions(
  root: string,
  targetFile: string,
  budgetTokens: number = DEFAULT_BUDGET_TOKENS,
): InstructionBlock {
  checkBudget(budgetTokens);
  const absoluteRoot = resolve(root);
  const target = repoRelative(absoluteRoot, targetFile);
  const directories = [""];
  const parts = dirname(target)
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  for (let i = 0; i < parts.length; i++) {
    directories.push(parts.slice(0, i + 1).join("/"));
  }

  interface Candidate {
    order: number;
    label: string;
    heading: string | null;
    text: string;
    priority: boolean;
  }
  const candidates: Candidate[] = [];
  for (const directory of directories) {
    const label = directory === "" ? AGENTS_FILE : `${directory}/${AGENTS_FILE}`;
    const content = readIfExists(join(absoluteRoot, label));
    if (content === null) {
      continue;
    }
    for (const section of parseSections(content)) {
      if (detectSecret(section.text) !== null) {
        continue;
      }
      candidates.push({
        order: candidates.length,
        label,
        heading: section.heading,
        text: section.text,
        priority: section.heading !== null && PRIORITY_PATTERN.test(section.heading),
      });
    }
  }

  const render = (chosen: readonly Candidate[]): string =>
    [...chosen]
      .sort((a, b) => a.order - b.order)
      .map((candidate) => candidate.text)
      .join("\n\n");

  const ordered = [...candidates].sort(
    (a, b) => Number(b.priority) - Number(a.priority) || a.order - b.order,
  );
  const chosen: Candidate[] = [];
  for (const candidate of ordered) {
    if (approximateTokens(render([...chosen, candidate])) <= budgetTokens) {
      chosen.push(candidate);
    }
  }
  const text = render(chosen);
  return {
    text,
    tokens: approximateTokens(text),
    sources: [...chosen]
      .sort((a, b) => a.order - b.order)
      .map((candidate) => `${candidate.label}#${candidate.heading ?? ""}`),
  };
}

const SKIPPED_NAMES_PREFIX = ".";

/** Relative paths ("/" separated, sorted) of every AGENTS.md under root, skipping dot dirs. */
export function findAgentsFiles(root: string): string[] {
  const absoluteRoot = resolve(root);
  if (!statSync(absoluteRoot).isDirectory()) {
    throw new MemoryError("invalid_path", `not a directory: ${root}`);
  }
  const found: string[] = [];
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (entry.name.startsWith(SKIPPED_NAMES_PREFIX) || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name === AGENTS_FILE) {
        found.push(relative(absoluteRoot, path).split(sep).join("/"));
      }
    }
  };
  walk(absoluteRoot);
  return found;
}

function scopeOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash === -1 ? "" : relativePath.slice(0, slash + 1);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Stores every AGENTS.md section under root as a convention record. A section is stored once,
 * keyed by a hash of its file and text. Re-importing unchanged files adds nothing. Convention
 * records whose section no longer exists are removed.
 */
export function importAgentsConventions(db: Sqlite.DatabaseSync, root: string): ImportResult {
  const result: ImportResult = { added: 0, unchanged: 0, removed: 0, skippedSecret: 0 };
  const absoluteRoot = resolve(root);
  const files = findAgentsFiles(absoluteRoot);
  const currentHashes = new Set<string>();
  const now = Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const file of files) {
      const content = readIfExists(join(absoluteRoot, file)) ?? "";
      for (const section of parseSections(content)) {
        if (detectSecret(section.text) !== null) {
          result.skippedSecret += 1;
          continue;
        }
        const hash = createHash("sha256").update(`${file}\0${section.text}`).digest("hex");
        currentHashes.add(hash);
        const existing = db.prepare("SELECT id FROM memory WHERE content_hash = ?").get(hash);
        if (existing !== undefined) {
          result.unchanged += 1;
          continue;
        }
        insertRecord(
          db,
          {
            kind: "convention",
            text: truncate(section.text.trim(), MAX_TEXT_LENGTH),
            filePath: scopeOf(file),
            source: file,
          },
          hash,
          now,
        );
        result.added += 1;
      }
    }

    const stored = db
      .prepare("SELECT id, content_hash FROM memory WHERE kind = 'convention'")
      .all();
    for (const row of stored) {
      const hash = row.content_hash;
      const id = row.id;
      if (typeof id === "number" && typeof hash === "string" && !currentHashes.has(hash)) {
        db.prepare("DELETE FROM memory WHERE id = ?").run(id);
        result.removed += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return result;
}
