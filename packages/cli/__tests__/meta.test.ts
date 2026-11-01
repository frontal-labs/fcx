import { describe, it, expect } from "vitest";
import { meta } from "../src/meta.js";
describe("meta", () => { it("binary is fcx", () => { expect(meta.binary).toBe("fcx"); }); });
