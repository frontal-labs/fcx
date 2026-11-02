import { describe, expect, it } from "vitest";
import { codeIdentifiers } from "../src/cite.js";

describe("codeIdentifiers", () => {
  it("ignores prose words", () => {
    expect([...codeIdentifiers("The function returns the total of all items.")]).toEqual([]);
  });

  it("picks up call and member names, camelCase, snake_case and backticked words", () => {
    const found = codeIdentifiers("`total` is computed by sumAll() and item.price via max_value");
    expect([...found].sort()).toEqual(["item", "max_value", "price", "sumAll", "total"]);
  });
});
