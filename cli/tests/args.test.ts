import { describe, expect, it } from "vitest";
import { parseGlobalArgs } from "../src/args.js";

describe("parseGlobalArgs", () => {
  it("defaults to text output and prompt-less flags", () => {
    const args = parseGlobalArgs(["status"]);
    expect(args).toMatchObject({
      command: "status",
      rest: [],
      outputFormat: "text",
      permissionMode: undefined,
      cwd: undefined,
    });
  });

  it("parses global flags before the command, in both value styles", () => {
    const args = parseGlobalArgs([
      "--output-format=json",
      "--permission-mode",
      "read-only",
      "-C",
      "/tmp/repo",
      "doctor",
    ]);
    expect(args).toMatchObject({
      command: "doctor",
      outputFormat: "json",
      permissionMode: "read-only",
      cwd: "/tmp/repo",
    });
  });

  it("passes command arguments through, and applies global flags wherever they appear", () => {
    const args = parseGlobalArgs(["fix", "src/a.ts:12", "--output-format", "json"]);
    expect(args.command).toBe("fix");
    expect(args.rest).toEqual(["src/a.ts:12"]);
    expect(args.outputFormat).toBe("json");
  });

  it("rejects invalid values instead of ignoring them", () => {
    expect(() => parseGlobalArgs(["--output-format", "yaml", "status"])).toThrow(/output-format/);
    expect(() => parseGlobalArgs(["--permission-mode", "yolo", "status"])).toThrow(
      /permission-mode/,
    );
  });

  it("parses --no-escalate as a global flag, off by default", () => {
    expect(parseGlobalArgs(["fix", "src/a.ts"]).noEscalate).toBe(false);
    expect(parseGlobalArgs(["--no-escalate", "fix", "src/a.ts"])).toMatchObject({
      command: "fix",
      noEscalate: true,
    });
  });

  it("rejects a missing value and unknown flags", () => {
    expect(() => parseGlobalArgs(["--permission-mode"])).toThrow(/requires a value/);
    expect(() => parseGlobalArgs(["--permission-mode", "--output-format", "json"])).toThrow(
      /requires a value/,
    );
    expect(() => parseGlobalArgs(["--dangerously-everything", "status"])).toThrow(/Unknown flag/);
  });
});
