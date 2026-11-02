import { describe, expect, it } from "vitest";
import { singleBlock } from "../src/index.js";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a block");
  return value;
}

/** Applies a block to text by exact, unique replacement, the same way the apply layer does. */
function apply(text: string, block: { search: string; replace: string }): string {
  const first = text.indexOf(block.search);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(block.search, first + 1)).toBe(-1);
  return text.slice(0, first) + block.replace + text.slice(first + block.search.length);
}

describe("singleBlock", () => {
  it("covers only the changed line when it is unique", () => {
    const before = "a\nb\nc\n";
    const after = "a\nB\nc\n";
    const block = singleBlock(before, after);
    expect(block).toBeDefined();
    expect(apply(before, must(block))).toBe(after);
  });

  it("widens to neighbouring lines when the changed line appears more than once", () => {
    // The changed line "foo();" occurs twice, so the block must include a neighbouring line.
    const before = "foo();\nx = 1;\nfoo();\n";
    const after = "foo();\nx = 1;\nfoo(2);\n";
    const block = singleBlock(before, after);
    expect(block).toBeDefined();
    expect(must(block).search.split("\n").length).toBeGreaterThan(1);
    expect(apply(before, must(block))).toBe(after);
  });

  it("handles a change at the very end of the file, where the replacement end must move", () => {
    const before = "one\ntwo\nthree\nfour\n";
    const after = "one\ntwo\nthree\nFOUR\n";
    const block = singleBlock(before, after);
    expect(block).toBeDefined();
    expect(apply(before, must(block))).toBe(after);
  });

  it("handles an inserted line", () => {
    const before = "a\nc\n";
    const after = "a\nb\nc\n";
    const block = singleBlock(before, after);
    expect(block).toBeDefined();
    expect(apply(before, must(block))).toBe(after);
  });
});
