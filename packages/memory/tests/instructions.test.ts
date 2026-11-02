import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryError, projectInstructions } from "../src/index";
import { type TempDir, makeTempDir } from "./helpers";

const ROOT_AGENTS = `# Repo guide

Intro line.

## Overview

Some overview text here about the project.

## Build

Run bun run build.

## Code style

Use double quotes.

## Test

Run bun run test.

## Lint

Run bun run lint.

## Typecheck

Run bun run typecheck.

## Deployment

Ship on Fridays.
`;

const NESTED_AGENTS = `## Testing

Use vitest with tests in tests/.
`;

const ALL_IN_DOCUMENT_ORDER = [
  "# Repo guide\n\nIntro line.",
  "## Overview\n\nSome overview text here about the project.",
  "## Build\n\nRun bun run build.",
  "## Code style\n\nUse double quotes.",
  "## Test\n\nRun bun run test.",
  "## Lint\n\nRun bun run lint.",
  "## Typecheck\n\nRun bun run typecheck.",
  "## Deployment\n\nShip on Fridays.",
  "## Testing\n\nUse vitest with tests in tests/.",
].join("\n\n");

describe("projectInstructions", () => {
  let dir: TempDir;

  beforeEach(() => {
    dir = makeTempDir();
    dir.file("AGENTS.md", ROOT_AGENTS);
    dir.file("packages/memory/AGENTS.md", NESTED_AGENTS);
  });

  afterEach(() => {
    dir.cleanup();
  });

  it("includes every section in document order when the budget is the 300-token default", () => {
    const block = projectInstructions(dir.path, "packages/memory/src/index.ts");
    expect(block.text).toBe(ALL_IN_DOCUMENT_ORDER);
    expect(block.tokens).toBe(92);
    expect(block.sources).toEqual([
      "AGENTS.md#Repo guide",
      "AGENTS.md#Overview",
      "AGENTS.md#Build",
      "AGENTS.md#Code style",
      "AGENTS.md#Test",
      "AGENTS.md#Lint",
      "AGENTS.md#Typecheck",
      "AGENTS.md#Deployment",
      "packages/memory/AGENTS.md#Testing",
    ]);
  });

  it("keeps build, test, lint and typecheck sections first when the budget is tight", () => {
    const block = projectInstructions(dir.path, "packages/memory/src/index.ts", 30);
    expect(block.text).toBe(
      "## Build\n\nRun bun run build.\n\n## Test\n\nRun bun run test.\n\n## Lint\n\nRun bun run lint.",
    );
    expect(block.tokens).toBe(24);
  });

  it("fills remaining budget with other sections, then prints everything in document order", () => {
    // Priority sections fill 35 tokens. The title section (non-priority, earlier in the document)
    // then fits in the remaining 12 tokens. Overview and Testing do not fit.
    const block = projectInstructions(dir.path, "packages/memory/src/index.ts", 47);
    expect(block.text).toBe(
      "# Repo guide\n\nIntro line.\n\n## Build\n\nRun bun run build.\n\n## Test\n\nRun bun run test.\n\n## Lint\n\nRun bun run lint.\n\n## Typecheck\n\nRun bun run typecheck.",
    );
    expect(block.tokens).toBe(43);
    expect(block.tokens).toBeLessThanOrEqual(47);
  });

  it("is exact at the budget boundary", () => {
    const at48 = projectInstructions(dir.path, "packages/memory/src/index.ts", 48);
    expect(at48.text).toContain("## Testing");
    expect(at48.tokens).toBe(48);
    const at8 = projectInstructions(dir.path, "packages/memory/src/index.ts", 8);
    expect(at8.text).toBe("## Build\n\nRun bun run build.");
    expect(at8.tokens).toBe(8);
  });

  it("returns an empty block for a zero budget", () => {
    expect(projectInstructions(dir.path, "packages/memory/src/index.ts", 0)).toEqual({
      text: "",
      tokens: 0,
      sources: [],
    });
  });

  it("is byte-for-byte deterministic for the same input", () => {
    const first = projectInstructions(dir.path, "packages/memory/src/index.ts", 40);
    const second = projectInstructions(dir.path, "packages/memory/src/index.ts", 40);
    expect(second.text).toBe(first.text);
    expect(second.sources).toEqual(first.sources);
  });

  it("reads only the root file for a target at the root", () => {
    const block = projectInstructions(dir.path, "README.md");
    expect(block.text).not.toContain("Use vitest");
    expect(block.text).toContain("## Build");
  });

  it("reads nested files only on the path to the target", () => {
    const block = projectInstructions(dir.path, "packages/other/src/x.ts");
    expect(block.text).not.toContain("Use vitest");
  });

  it("ignores headings inside code fences", () => {
    dir.file(
      "docs/AGENTS.md",
      "## Real\n\nText.\n\n```md\n## Build\nnot a heading\n```\n\n## Tail\n\nMore.\n",
    );
    const block = projectInstructions(dir.path, "docs/x.md", 300);
    expect(block.sources.filter((source) => source.startsWith("docs/"))).toEqual([
      "docs/AGENTS.md#Real",
      "docs/AGENTS.md#Tail",
    ]);
    expect(block.text).toContain("## Build\nnot a heading");
  });

  it("omits sections that contain secrets", () => {
    dir.file(
      "secrets/AGENTS.md",
      "## Build\n\nUse key sk-abcdefghijklmnop1234 for builds.\n\n## Lint\n\nRun lint.\n",
    );
    const block = projectInstructions(dir.path, "secrets/x.ts", 300);
    expect(block.text).not.toContain("sk-abcdef");
    expect(block.text).toContain("## Lint\n\nRun lint.");
  });

  it("returns an empty block when there are no AGENTS.md files", () => {
    const empty = makeTempDir();
    try {
      expect(projectInstructions(empty.path, "a/b.ts")).toEqual({
        text: "",
        tokens: 0,
        sources: [],
      });
    } finally {
      empty.cleanup();
    }
  });

  it("rejects a target outside the repository", () => {
    expect(() => projectInstructions(dir.path, "../outside.ts")).toThrow(
      expect.objectContaining({ code: "invalid_path" }),
    );
  });

  it("rejects an invalid budget", () => {
    expect(() => projectInstructions(dir.path, "a.ts", -1)).toThrow(MemoryError);
    expect(() => projectInstructions(dir.path, "a.ts", 2.5)).toThrow(MemoryError);
  });
});
