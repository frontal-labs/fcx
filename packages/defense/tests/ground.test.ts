import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Checker, createTsChecker } from "@fcx/verify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedLines } from "../src/ground.js";
import { ground } from "../src/index.js";

const UTIL = [
  "export function helper(n: number): number {",
  "  return n + 1;",
  "}",
  'export const config = { retries: 3, name: "x" };',
  "",
].join("\n");

const MAIN = [
  'import { helper, config } from "./util.js";',
  "",
  "const local = 1;",
  "export function run(total: number): number {",
  "  return helper(total) + local + config.retries;",
  "}",
  "",
].join("\n");

describe("ground layer", () => {
  let ws: string;
  let file: string;
  let checker: Checker;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "fcx-ground-"));
    mkdirSync(join(ws, "src"));
    writeFileSync(
      join(ws, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
        },
        include: ["src"],
      }),
    );
    writeFileSync(join(ws, "src", "util.ts"), UTIL);
    file = join(ws, "src", "main.ts");
    writeFileSync(file, MAIN);
    checker = createTsChecker(ws, file);
  });

  afterEach(() => {
    checker.dispose();
    rmSync(ws, { recursive: true, force: true });
  });

  /** Replaces `from` with `to` in the original main file and grounds the result. */
  const groundEdit = (from: string, to: string) => {
    const candidateText = MAIN.replace(from, to);
    expect(candidateText).not.toBe(MAIN);
    return ground({ checker, file, originalText: MAIN, candidateText });
  };

  it("passes a name defined locally in the edited text", () => {
    const outcome = groundEdit(
      "  return helper(total) + local + config.retries;",
      "  const extra = local * 2;\n  return helper(total) + extra;",
    );
    expect(outcome).toMatchObject({ layer: "ground", pass: true });
  });

  it("passes names that are imported, and members of a known object", () => {
    const outcome = groundEdit(
      "  return helper(total) + local + config.retries;",
      "  return helper(config.retries) + local;",
    );
    expect(outcome).toMatchObject({ pass: true });
  });

  it("passes a symbol declared in another project file", () => {
    const outcome = groundEdit("helper(total)", "helper(config.name.length)");
    expect(outcome.pass).toBe(true);
  });

  it("fails a misspelled identifier with UNKNOWN_IDENTIFIER and nearest in-scope suggestions", () => {
    const outcome = groundEdit("helper(total)", "helpr(total)");
    expect(outcome).toMatchObject({
      pass: false,
      reasonCode: "UNKNOWN_IDENTIFIER",
      layer: "ground",
    });
    expect(!outcome.pass && outcome.feedback).toBe(
      "Unknown identifier 'helpr'. Did you mean: helper?",
    );
  });

  it("suggests in-scope parameters and locals, not only top-level names", () => {
    const outcome = groundEdit("helper(total)", "helper(totl)");
    expect(!outcome.pass && outcome.feedback).toMatch(
      /^Unknown identifier 'totl'\. Did you mean: total/,
    );
  });

  it("fails an unknown identifier with no close name without inventing suggestions", () => {
    const outcome = groundEdit("helper(total)", "zzqqxx(total)");
    expect(outcome).toMatchObject({ pass: false, reasonCode: "UNKNOWN_IDENTIFIER" });
    expect(!outcome.pass && outcome.feedback).toBe(
      "Unknown identifier 'zzqqxx'. Define it or import it before use.",
    );
  });

  it("fails a misspelled member of a known object with UNKNOWN_MEMBER and suggestions", () => {
    const outcome = groundEdit("config.retries", "config.retires");
    expect(outcome).toMatchObject({ pass: false, reasonCode: "UNKNOWN_MEMBER" });
    expect(!outcome.pass && outcome.feedback).toBe(
      "Unknown member 'retires' on type '{ retries: number; name: string; }'. Did you mean: retries?",
    );
  });

  it("does not flag language builtins such as Math and console", () => {
    const outcome = groundEdit(
      "  return helper(total) + local + config.retries;",
      "  console.log(Math.max(total, 1));\n  return helper(total) + local + config.retries;",
    );
    expect(outcome.pass).toBe(true);
  });

  it("does not blame names that were already unresolved before the edit", () => {
    const broken = MAIN.replace("const local = 1;", "const local = missingThing;");
    writeFileSync(file, broken);
    const outcome = ground({
      checker,
      file,
      originalText: broken,
      candidateText: broken.replace("const local = missingThing;", "const local = 2;"),
    });
    expect(outcome.pass).toBe(true);
  });

  it("reports a bad name in the changed lines even when the file already had one elsewhere", () => {
    const broken = MAIN.replace("const local = 1;", "const local = missingThing;");
    writeFileSync(file, broken);
    const outcome = ground({
      checker,
      file,
      originalText: broken,
      candidateText: broken.replace("helper(total)", "helpr(total)"),
    });
    expect(outcome).toMatchObject({ pass: false, reasonCode: "UNKNOWN_IDENTIFIER" });
  });

  it("passes a non-TypeScript file, since it is out of scope for this layer", () => {
    const outcome = ground({
      checker,
      file: join(ws, "notes.md"),
      originalText: "a",
      candidateText: "b undefinedThing",
    });
    expect(outcome.pass).toBe(true);
  });

  it("keeps feedback to at most 20 lines, even when the candidate is full of unknown names", () => {
    const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = unknownName${i};`).join(
      "\n",
    );
    const outcome = groundEdit(
      "  return helper(total) + local + config.retries;",
      `${body}\n  return v0;`,
    );
    expect(outcome.pass).toBe(false);
    if (!outcome.pass) {
      expect(outcome.feedback.split("\n").length).toBeLessThanOrEqual(20);
      expect(outcome.feedback).toMatch(/Unknown identifier 'unknownName0'/);
    }
  });
});

describe("changedLines", () => {
  it("returns the changed line range of the candidate", () => {
    expect(changedLines("a\nb\nc", "a\nX\nc")).toEqual({ first: 2, last: 2 });
    expect(changedLines("a\nb", "a\nb\nc")).toEqual({ first: 3, last: 3 });
  });

  it("returns undefined when nothing changed or only lines were removed", () => {
    expect(changedLines("a\nb", "a\nb")).toBeUndefined();
    expect(changedLines("a\nb\nc", "a\nc")).toBeUndefined();
  });
});
