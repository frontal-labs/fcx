import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/index";

describe("config", () => {
  it("resolves config", () => {
    const cfg = resolveConfig(process.cwd());
    expect(cfg.permissionMode).toBe("prompt");
  });
});
