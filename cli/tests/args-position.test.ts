import { describe, expect, it } from "vitest";
import { parseGlobalArgs } from "../src/args.js";

describe("global flags are accepted after the command too", () => {
  it("takes --no-escalate placed after the command", () => {
    const args = parseGlobalArgs(["fix", "src/a.ts:3", "--no-escalate"]);
    expect(args.noEscalate).toBe(true);
    expect(args.command).toBe("fix");
    expect(args.rest).toEqual(["src/a.ts:3"]);
  });

  it("takes --output-format after the command", () => {
    const args = parseGlobalArgs(["memory", "list", "--output-format", "json"]);
    expect(args.outputFormat).toBe("json");
    expect(args.rest).toEqual(["list"]);
  });

  it("passes command-specific flags through untouched", () => {
    const args = parseGlobalArgs(["memory", "list", "--kind", "convention"]);
    expect(args.rest).toEqual(["list", "--kind", "convention"]);
  });
});
