import { describe, expect, it } from "vitest";
import { containsWord } from "../src/cite.js";
import { type Claim, cite } from "../src/index.js";

const WORKSPACE = "/repo";
const FILES: Record<string, string> = {
  "/repo/src/a.ts": [
    "export function parse(input: string): Node {",
    "  const tokens = tokenize(input);",
    "  return build(tokens);",
    "}",
    "",
  ].join("\n"),
  "/repo/src/b.ts": "export const limit = 10;",
};

/** An in-memory file reader: missing paths throw, like a real missing file would. */
const readFile = (path: string): string => {
  const text = FILES[path];
  if (text === undefined) throw new Error(`ENOENT: ${path}`);
  return text;
};

const options = { workspace: WORKSPACE, readFile };

describe("cite layer", () => {
  it("keeps a claim whose identifiers all appear in the cited span", () => {
    const claim: Claim = {
      text: "parse tokenize build",
      cites: [{ file: "src/a.ts", start: 1, end: 3 }],
    };
    const result = cite([claim], options);
    expect(result.kept).toEqual([claim]);
    expect(result.dropped).toEqual([]);
    expect(result.regenerate).toBe(false);
  });

  it("accepts an absolute citation path inside the workspace", () => {
    const claim: Claim = { text: "`limit`", cites: [{ file: "/repo/src/b.ts", start: 1, end: 1 }] };
    expect(cite([claim], options).kept).toHaveLength(1);
  });

  it("drops a claim whose citation range is past the end of the file", () => {
    const claim: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 1, end: 40 }] };
    const result = cite([claim], options);
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([{ claim, reasonCode: "RANGE_OUT_OF_BOUNDS" }]);
  });

  it("drops a claim whose citation range is malformed", () => {
    const zero: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 0, end: 1 }] };
    const reversed: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 3, end: 1 }] };
    const fractional: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 1.5, end: 2 }] };
    const result = cite([zero, reversed, fractional], options);
    expect(result.dropped.map((d) => d.reasonCode)).toEqual([
      "RANGE_INVALID",
      "RANGE_INVALID",
      "RANGE_INVALID",
    ]);
  });

  it("drops a claim whose cited file does not exist", () => {
    const claim: Claim = { text: "parse", cites: [{ file: "src/missing.ts", start: 1, end: 1 }] };
    expect(cite([claim], options).dropped).toEqual([{ claim, reasonCode: "FILE_NOT_FOUND" }]);
  });

  it("drops a claim whose cited file is outside the workspace", () => {
    const claim: Claim = { text: "parse", cites: [{ file: "../etc/passwd", start: 1, end: 1 }] };
    expect(cite([claim], options).dropped).toEqual([
      { claim, reasonCode: "FILE_OUTSIDE_WORKSPACE" },
    ]);
  });

  it("drops a claim with no citation at all", () => {
    const claim: Claim = { text: "parse", cites: [] };
    expect(cite([claim], options).dropped).toEqual([{ claim, reasonCode: "NO_CITATION" }]);
  });

  it("drops a claim whose identifier is not in the cited span", () => {
    const claim: Claim = {
      text: "`parse` calls `verify()`",
      cites: [{ file: "src/a.ts", start: 1, end: 3 }],
    };
    const result = cite([claim], options);
    expect(result.dropped).toEqual([{ claim, reasonCode: "IDENTIFIER_NOT_IN_CITATION" }]);
  });

  it("matches identifiers case-sensitively", () => {
    const claim: Claim = { text: "`Parse`", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    expect(cite([claim], options).dropped[0]?.reasonCode).toBe("IDENTIFIER_NOT_IN_CITATION");
  });

  it("matches identifiers on word boundaries only", () => {
    const claim: Claim = { text: "`pars`", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    expect(cite([claim], options).dropped[0]?.reasonCode).toBe("IDENTIFIER_NOT_IN_CITATION");
  });

  it("checks identifiers only against the lines inside the citation", () => {
    const claim: Claim = { text: "`limit`", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    expect(cite([claim], options).dropped[0]?.reasonCode).toBe("IDENTIFIER_NOT_IN_CITATION");
  });

  it("discards an invalid citation but keeps the claim on a valid one", () => {
    const claim: Claim = {
      text: "parse tokenize",
      cites: [
        { file: "src/missing.ts", start: 1, end: 1 },
        { file: "src/a.ts", start: 1, end: 2 },
      ],
    };
    expect(cite([claim], options).kept).toEqual([claim]);
  });

  it("drops a claim when every citation is invalid, and says why", () => {
    const claim: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 90, end: 99 }] };
    expect(cite([claim], options).dropped).toEqual([{ claim, reasonCode: "RANGE_OUT_OF_BOUNDS" }]);
  });

  it("does not repair a dropped claim: kept and dropped partition the input", () => {
    const good: Claim = { text: "`parse`", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    const bad: Claim = { text: "`nothing`", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    const result = cite([good, bad], options);
    expect(result.kept).toEqual([good]);
    expect(result.dropped.map((d) => d.claim)).toEqual([bad]);
  });

  describe("regenerate threshold", () => {
    const keep: Claim = { text: "parse", cites: [{ file: "src/a.ts", start: 1, end: 3 }] };
    const drop: Claim = { text: "parse", cites: [] };
    const run = (kept: number, dropped: number) =>
      cite([...Array(kept).fill(keep), ...Array(dropped).fill(drop)], options);

    it("does not ask to regenerate when nothing is dropped", () => {
      expect(run(3, 0).regenerate).toBe(false);
    });

    it("does not ask to regenerate at exactly half dropped", () => {
      expect(run(2, 2).regenerate).toBe(false);
      expect(run(1, 1).regenerate).toBe(false);
    });

    it("asks to regenerate just above half dropped", () => {
      expect(run(1, 2).regenerate).toBe(true);
      expect(run(1, 3).regenerate).toBe(true);
    });

    it("asks to regenerate when all claims are dropped", () => {
      expect(run(0, 3).regenerate).toBe(true);
    });

    it("does not ask to regenerate for an empty claim list", () => {
      expect(cite([], options)).toEqual({ kept: [], dropped: [], regenerate: false });
    });
  });
});

describe("containsWord", () => {
  it("matches a whole identifier, including ones containing $", () => {
    expect(containsWord("const $store = 1", "$store")).toBe(true);
    expect(containsWord("const x = a.parse(b)", "parse")).toBe(true);
  });

  it("rejects a substring, a longer identifier, or a different case", () => {
    expect(containsWord("parser", "parse")).toBe(false);
    expect(containsWord("xparse", "parse")).toBe(false);
    expect(containsWord("Parse", "parse")).toBe(false);
    expect(containsWord("$store", "store")).toBe(false);
  });
});
