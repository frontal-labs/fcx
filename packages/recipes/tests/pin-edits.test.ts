import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pinEditsToTarget } from "../src/engine.js";

describe("pinEditsToTarget", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-pin-"));
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "tests"), { recursive: true });
    writeFileSync(join(ws, "src/math.ts"), "x\n");
    writeFileSync(join(ws, "tests/math.test.ts"), "x\n");
    writeFileSync(join(ws, "src/other.ts"), "x\n");
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  const allowed = (): string[] => [join(ws, "src/math.ts"), join(ws, "tests/math.test.ts")];

  it("points an invented path at the allowed file with the same name", () => {
    const [edit] = pinEditsToTarget(
      [{ file: "/path/to/math.test.ts", search: "a", replace: "b" }],
      ws,
      allowed(),
    );
    expect(edit?.file).toBe("tests/math.test.ts");
  });

  it("uses the only allowed file whatever name the model gave", () => {
    const [edit] = pinEditsToTarget(
      [{ file: "/src/add_types_01.ts", search: "a", replace: "b" }],
      ws,
      [join(ws, "src/math.ts")],
    );
    expect(edit?.file).toBe("src/math.ts");
  });

  it("leaves a real file that is not allowed alone, so constrain still rejects it", () => {
    const [edit] = pinEditsToTarget([{ file: "src/other.ts", search: "a", replace: "b" }], ws, [
      join(ws, "src/math.ts"),
    ]);
    expect(edit?.file).toBe("src/other.ts");
  });
});
