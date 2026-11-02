import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELP, run } from "../src/app.js";
import { parseGlobalArgs } from "../src/args.js";
import { parseCommandArgs } from "../src/lib/command-args.js";
import { parseFileLine, parseFileLineColumn, parseFileSymbol } from "../src/lib/target.js";
import { type Sandbox, captureLog, makeSandbox } from "./support.js";

const NEW_COMMANDS = [
  "fix-test",
  "test",
  "write-test",
  "implement",
  "types",
  "doc",
  "refactor",
  "rename",
  "explain",
  "commit",
  "ask",
];

describe("fcx --help", () => {
  it("lists every command, the new ones with a description", async () => {
    const { code, lines } = await captureLog(() => run(parseGlobalArgs(["--help"])));
    expect(code).toBe(0);
    const help = lines.join("\n");
    expect(help).toBe(HELP);
    for (const name of ["status", "doctor", "fix", "undo", "memory", "index", ...NEW_COMMANDS]) {
      expect(help).toMatch(new RegExp(`^  (${name}|.*\\b${name}\\b)`, "m"));
    }
    expect(help).not.toMatch(/fix-test\s+\(not implemented/);
    expect(help).not.toMatch(/ask \[question\]\s+.*not implemented/);
  });
});

describe("recipe command arguments", () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = makeSandbox("fcx-help-");
  });
  afterEach(() => sb.cleanup());

  it("parses flags with values, inline values, and -- for positionals", () => {
    expect(
      parseCommandArgs(["a.ts", "--name", "adds"], { values: ["--name"], flags: [] }),
    ).toMatchObject({
      positionals: ["a.ts"],
    });
    const inline = parseCommandArgs(["--name=adds", "a.ts"], { values: ["--name"], flags: [] });
    expect(typeof inline !== "string" && inline.values.get("--name")).toBe("adds");
    const dashed = parseCommandArgs(["--", "-x"], { values: [], flags: [] });
    expect(typeof dashed !== "string" && dashed.positionals).toEqual(["-x"]);
    expect(parseCommandArgs(["--bogus"], { values: [], flags: [] })).toMatch(/unknown argument/);
    expect(parseCommandArgs(["--name"], { values: ["--name"], flags: [] })).toMatch(
      /requires a value/,
    );
  });

  it("parses targets and rejects bad line numbers", () => {
    expect(parseFileSymbol("src/a.ts:total")).toEqual({ file: "src/a.ts", symbol: "total" });
    expect(parseFileSymbol("src/a.ts")).toEqual({ file: "src/a.ts" });
    expect(parseFileLine("src/a.ts:0")).toMatch(/start at 1/);
    expect(parseFileLine("src/a.ts:12")).toEqual({ file: "src/a.ts", line: 12 });
    expect(parseFileLineColumn("src/a.ts:3:7")).toEqual({ file: "src/a.ts", line: 3, column: 7 });
    expect(parseFileLineColumn("src/a.ts:3")).toMatch(/file:line:column/);
  });

  it("fix-test without --name is a usage error, in JSON, before any model loads", async () => {
    const args = parseGlobalArgs(["--output-format", "json", "fix-test", "tests/a.test.ts"]);
    const { code, lines } = await captureLog(() => run({ ...args, cwd: sb.workspace }));
    expect(code).toBe(1);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({
      command: "fix-test",
      status: "error",
      error: { code: "USAGE" },
    });
  });

  it("implement with a bad target is a usage error in text", async () => {
    const args = parseGlobalArgs(["implement", "src/a.ts"]);
    const { code, lines } = await captureLog(() => run({ ...args, cwd: sb.workspace }));
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("USAGE: expected file:line");
  });
});
