import { describe, expect, it } from "vitest";
import { anchor, constrain } from "../src/index.js";

const bundle = { workspace: "/repo", allowedFiles: ["/repo/src/a.ts"] };

describe("constrain", () => {
  it("passes edits to an allowed file", () => {
    expect(constrain([{ file: "src/a.ts", search: "x", replace: "y" }], bundle).pass).toBe(true);
  });

  it("rejects a file that is in the workspace but not allowed", () => {
    const outcome = constrain([{ file: "src/b.ts", search: "x", replace: "y" }], bundle);
    expect(outcome).toMatchObject({ pass: false, reasonCode: "PATH_NOT_ALLOWED" });
  });

  it("rejects a path that escapes the workspace", () => {
    const outcome = constrain([{ file: "../etc/passwd", search: "x", replace: "y" }], bundle);
    expect(outcome).toMatchObject({ pass: false, reasonCode: "PATH_OUTSIDE_WORKSPACE" });
  });
});

describe("anchor", () => {
  const read = () => "const a = 1;\nconst b = 2;\n";

  it("returns the edited text when each search matches once", () => {
    const { outcome, texts } = anchor(
      [{ file: "src/a.ts", search: "const a = 1;", replace: "const a = 3;" }],
      bundle,
      read,
    );
    expect(outcome.pass).toBe(true);
    expect(texts.get("/repo/src/a.ts")).toBe("const a = 3;\nconst b = 2;\n");
  });

  it("fails when the search text is missing, with feedback that says so", () => {
    const { outcome } = anchor([{ file: "src/a.ts", search: "nope", replace: "x" }], bundle, read);
    expect(outcome).toMatchObject({ pass: false, reasonCode: "ANCHOR_NOT_FOUND" });
    expect(!outcome.pass && outcome.feedback).toMatch(/does not match the file exactly/);
  });

  it("fails when the search text is ambiguous, with feedback that asks for more context", () => {
    const repeated = () => "x;\nx;\n";
    const { outcome } = anchor(
      [{ file: "src/a.ts", search: "x;", replace: "y;" }],
      bundle,
      repeated,
    );
    expect(outcome).toMatchObject({ pass: false, reasonCode: "ANCHOR_NOT_UNIQUE" });
    expect(!outcome.pass && outcome.feedback).toMatch(/more than once/);
  });

  it("applies several edits to one file in sequence", () => {
    const edits = [
      { file: "src/a.ts", search: "const a = 1;", replace: "const a = 5;" },
      { file: "src/a.ts", search: "const b = 2;", replace: "const b = 6;" },
    ];
    const { outcome, texts } = anchor(edits, bundle, read);
    expect(outcome.pass).toBe(true);
    expect(texts.get("/repo/src/a.ts")).toBe("const a = 5;\nconst b = 6;\n");
  });
});
