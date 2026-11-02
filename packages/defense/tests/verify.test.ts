import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Checker, type Diagnostic, createTsChecker, errorsOnly } from "@fcx/verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verify } from "../src/index.js";

const TWO_IDENTICAL = 'export const a: number = "x";\nexport const b: number = "y";\n';

describe("verify layer: counting duplicate errors", () => {
  let ws: string;
  let file: string;
  let checker: Checker;
  let errors: Diagnostic[];

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-verify-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
    );
    file = join(ws, "src", "a.ts");
    writeFileSync(file, TWO_IDENTICAL);
    checker = createTsChecker(ws, file);
    errors = errorsOnly(checker.diagnostics(file));
  });

  afterEach(() => {
    checker.dispose();
    rmSync(ws, { recursive: true, force: true });
  });

  const run = (candidateText: string) =>
    verify({
      checker,
      file,
      workspace: ws,
      candidateText,
      target: errors[0] as Diagnostic,
      originalErrors: errors,
    });

  it("accepts fixing one of two identical errors", () => {
    const outcome = run('export const a: number = 1;\nexport const b: number = "y";\n');
    expect(outcome.pass).toBe(true);
  });

  it("rejects a fix that also adds an identical error elsewhere, since the target count did not go down", () => {
    // Fixes `a`, but adds a third identical error on a new line: the count stays at two.
    const outcome = run(
      'export const a: number = 1;\nexport const b: number = "y";\nexport const c: number = "w";\n',
    );
    // Fixing one and adding another identical error leaves the count unchanged, so the target is not fixed.
    expect(outcome.pass).toBe(false);
    expect(!outcome.pass && outcome.reasonCode).toBe("TARGET_NOT_FIXED");
  });

  it("rejects a fix that introduces a different error", () => {
    const outcome = run("export const a: number = 1;\nexport const b: number = missing;\n");
    expect(outcome.pass).toBe(false);
    expect(!outcome.pass && outcome.reasonCode).toBe("NEW_ERROR");
  });
});
