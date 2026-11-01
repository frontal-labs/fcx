import { describe, expect, it } from "vitest";
import { createMockModelHost } from "../src/index";

describe("model", () => {
  it("creates mock host", () => {
    const host = createMockModelHost();
    expect(host.countTokens("hello")).toBeGreaterThan(0);
  });
});
