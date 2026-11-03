import { describe, expect, it } from "vitest";
import { applyEditsToText } from "../src/text.js";

describe("applyEditsToText with a loose match", () => {
  const file = ["function f() {", "    return 1;", "}", "const x = 2;", ""].join("\n");

  it("matches when the search lines differ only in indentation or trailing spaces", () => {
    const out = applyEditsToText(file, [{ search: "return 1;  \n}", replace: "return 3;\n}" }]);
    expect(out).toBe(["function f() {", "return 3;", "}", "const x = 2;", ""].join("\n"));
  });

  it("still uses the exact match when there is one", () => {
    const out = applyEditsToText(file, [{ search: "const x = 2;", replace: "const x = 5;" }]);
    expect(out).toContain("const x = 5;");
  });

  it("refuses a loose match that occurs in more than one place", () => {
    const twice = ["  a();", "x", "a();"].join("\n");
    expect(() => applyEditsToText(twice, [{ search: "a();", replace: "b();" }])).toThrow(
      "more than once",
    );
  });

  it("reports a search that matches nowhere", () => {
    expect(() => applyEditsToText(file, [{ search: "missing();", replace: "" }])).toThrow(
      "does not occur",
    );
  });
});
