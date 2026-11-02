import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECIPE_DESCRIPTIONS,
  RECIPE_IDS,
  ROUTER_SYSTEM,
  RouterSchemaError,
  route,
} from "../src/router.js";
import { queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "router.md");

describe("router prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    const source = readFileSync(PROMPT_FILE, "utf-8");
    const body = source
      .split("\n")
      .filter(
        (line, i, all) =>
          !(
            line.startsWith("//") &&
            all.slice(0, i + 1).every((l) => l.startsWith("//") || l === "")
          ),
      )
      .join("\n")
      .trim();
    expect(ROUTER_SYSTEM).toBe(body);
  });

  it("lists exactly the ten recipes, each with a description", () => {
    expect(RECIPE_IDS).toHaveLength(10);
    for (const id of RECIPE_IDS) {
      expect(RECIPE_DESCRIPTIONS[id].length).toBeGreaterThan(0);
      expect(ROUTER_SYSTEM).toContain(`${id}:`);
    }
  });
});

describe("route", () => {
  it("returns an explicit recipe id without calling the model", async () => {
    const model = queueModel([]);
    const result = await route({ model, text: "fix src/foo.ts:12", recipe: "fix-diagnostic" });
    expect(result).toEqual({ recipe: "fix-diagnostic", source: "explicit" });
    expect(model.prompts).toHaveLength(0);
  });

  it("rejects an explicit id that is not a recipe, without calling the model", async () => {
    const model = queueModel([]);
    await expect(route({ model, text: "x", recipe: "refactor" })).rejects.toBeInstanceOf(
      RouterSchemaError,
    );
    expect(model.prompts).toHaveLength(0);
  });

  it("routes free text to a recipe with its target", async () => {
    const model = queueModel([{ recipe: "fix-test", target: "TestUserLogin" }]);
    const result = await route({ model, text: "the login test keeps failing" });
    expect(result).toEqual({
      recipe: "fix-test",
      target: "TestUserLogin",
      source: "model",
      instructionsTruncated: false,
    });
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]?.startsWith(ROUTER_SYSTEM)).toBe(true);
    expect(model.prompts[0]).toContain("Task: the login test keeps failing");
  });

  it("returns unsupported with the model's reason", async () => {
    const model = queueModel([
      { recipe: "unsupported", reason: "fcx cannot deploy code. Try the deploy tool instead." },
    ]);
    const result = await route({ model, text: "deploy this to production" });
    expect(result).toEqual({
      recipe: "unsupported",
      reason: "fcx cannot deploy code. Try the deploy tool instead.",
      source: "model",
      instructionsTruncated: false,
    });
  });

  it("reports a model output outside the recipe enum as a schema error, not a guess", async () => {
    const model = queueModel([{ recipe: "fix" }]);
    await expect(route({ model, text: "fix the bug" })).rejects.toBeInstanceOf(RouterSchemaError);
  });

  it("reports a model output with no recipe field as a schema error", async () => {
    const model = queueModel([{ target: "src/foo.ts" }]);
    await expect(route({ model, text: "fix src/foo.ts" })).rejects.toThrow(/schema/);
  });
});

describe("route project instructions", () => {
  it("puts the heading and instruction text after the system text, before the task", async () => {
    const absent = queueModel([{ recipe: "docstring", target: "format" }]);
    const withRules = queueModel([{ recipe: "docstring", target: "format" }]);
    await route({ model: absent, text: "document format" });
    const result = await route({
      model: withRules,
      text: "document format",
      instructions: "Write docs in English.",
    });
    expect(withRules.prompts[0]).toBe(
      `${ROUTER_SYSTEM}\n\nProject instructions:\nWrite docs in English.\n\nTask: document format`,
    );
    expect(absent.prompts[0]).toBe(`${ROUTER_SYSTEM}\n\nTask: document format`);
    expect(result).toMatchObject({ recipe: "docstring", instructionsTruncated: false });
  });
});
