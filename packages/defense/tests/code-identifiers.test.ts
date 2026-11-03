import { describe, expect, it } from "vitest";
import { codeIdentifiers, quotedLiterals } from "../src/cite.js";

describe("quotedLiterals", () => {
  it("picks up quoted paths, ids and versions, and ignores prose quotes", () => {
    const found = quotedLiterals(
      `The alias 'ggml/auto' and "max-tokens" and 'v1.5' are set. He said "hi".`,
    );
    expect([...found].sort()).toEqual(["ggml/auto", "max-tokens", "v1.5"]);
  });

  it("does not read contractions with a slash as quoted literals", () => {
    expect(quotedLiterals("It doesn't/won't matter here").size).toBe(0);
  });
});

describe("codeIdentifiers", () => {
  it("ignores prose words", () => {
    expect([...codeIdentifiers("The function returns the total of all items.")]).toEqual([]);
  });

  it("picks up call and member names, camelCase, snake_case and backticked words", () => {
    const found = codeIdentifiers("`total` is computed by sumAll() and item.price via max_value");
    expect([...found].sort()).toEqual(["item", "max_value", "price", "sumAll", "total"]);
  });
});
