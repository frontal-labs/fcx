import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_HEADING,
  INSTRUCTIONS_MAX_CHARS,
  prepareInstructions,
  withInstructions,
} from "../src/instructions.js";

describe("prepareInstructions", () => {
  it("treats undefined, empty and whitespace-only text as absent", () => {
    for (const input of [undefined, "", "  \n\t\n"]) {
      expect(prepareInstructions(input)).toEqual({ text: "", truncated: false });
    }
  });

  it("keeps text at or under the budget unchanged", () => {
    const exact = "a".repeat(INSTRUCTIONS_MAX_CHARS);
    expect(prepareInstructions("Use tabs.\nNo default exports.")).toEqual({
      text: "Use tabs.\nNo default exports.",
      truncated: false,
    });
    expect(prepareInstructions(exact)).toEqual({ text: exact, truncated: false });
  });

  it("cuts over-budget text at a line boundary and flags it", () => {
    // Each line is 100 characters. Eleven lines with newlines are 1120 characters; twelve would be 1211.
    const lines = Array.from({ length: 20 }, (_, i) => String(i).padEnd(100, "-"));
    const out = prepareInstructions(lines.join("\n"));
    expect(out.truncated).toBe(true);
    expect(out.text).toBe(lines.slice(0, 11).join("\n"));
    expect(out.text.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(out.text.endsWith("-")).toBe(true);
  });

  it("returns empty text and flags it when the first line alone is over budget", () => {
    const out = prepareInstructions(`${"x".repeat(INSTRUCTIONS_MAX_CHARS + 1)}\nsecond`);
    expect(out).toEqual({ text: "", truncated: true });
  });
});

describe("withInstructions", () => {
  it("returns the user text unchanged when there is no instruction text", () => {
    expect(withInstructions("USER", "")).toBe("USER");
  });

  it("places the heading and text before the user text, with a blank line after", () => {
    expect(withInstructions("USER", "Use tabs.")).toBe(
      `${INSTRUCTIONS_HEADING}\nUse tabs.\n\nUSER`,
    );
    expect(INSTRUCTIONS_HEADING).toBe("Project instructions:");
  });
});
