import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RecipeInputError } from "../src/context.js";
import { EXPLAIN_SYSTEM, runExplain } from "../src/recipes/explain.js";
import { makeWorkspace, promptBody, queueModel } from "./support.js";

const PROMPT_FILE = join(import.meta.dirname, "..", "..", "..", "prompts", "explain.md");

const CART = [
  "export function sumPrices(items: number[]): number {", // 1
  "  return items.reduce((total, price) => total + price, 0);", // 2
  "}", // 3
  "", // 4
  "export function applyDiscount(total: number, rate: number): number {", // 5
  "  return total * (1 - rate);", // 6
  "}", // 7
  "", // 8
].join("\n");

describe("runExplain", () => {
  let fixture: ReturnType<typeof makeWorkspace>;

  beforeEach(() => {
    fixture = makeWorkspace({ "src/cart.ts": CART });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  const run = (outputs: unknown[]) => {
    const model = queueModel(outputs);
    return {
      model,
      result: runExplain({
        model,
        workspace: fixture.ws,
        file: "src/cart.ts",
        startLine: 1,
        endLine: 3,
        question: "What does this do?",
      }),
    };
  };

  it("answers when every claim cites a real range that contains its identifiers", async () => {
    const { model, result } = run([
      {
        summary: "Adds up the prices in a list.",
        claims: [
          {
            text: "`sumPrices` returns the total of `items`.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          {
            text: "It calls `reduce` on `items`.",
            cites: [{ file: "src/cart.ts", start: 2, end: 2 }],
          },
        ],
      },
    ]);
    const out = await result;
    expect(out.status).toBe("answered");
    if (out.status !== "answered") return;
    expect(out.answer.summary).toBe("Adds up the prices in a list.");
    expect(out.answer.claims).toHaveLength(2);
    expect(out.answer.claims[1]?.cites).toEqual([{ file: "src/cart.ts", start: 2, end: 2 }]);
    expect(out.dropped).toEqual([]);
    expect(out.attempts).toBe(1);
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain("What does this do?");
    expect(model.prompts[0]).toContain("   2|   return items.reduce");
  });

  it("drops a claim whose identifier is outside the cited range", async () => {
    const { result } = run([
      {
        summary: "Explains the cart.",
        claims: [
          {
            text: "`sumPrices` returns the total.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          {
            text: "`applyDiscount` multiplies by one minus the rate.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
        ],
      },
    ]);
    const out = await result;
    expect(out.status).toBe("answered");
    expect(out.answer.claims.map((c) => c.text)).toEqual(["`sumPrices` returns the total."]);
    expect(out.dropped.map((d) => d.reasonCode)).toEqual(["IDENTIFIER_NOT_IN_CITATION"]);
    expect(out.attempts).toBe(1);
  });

  it("abstains when every claim is dropped, after one regeneration", async () => {
    const bad = {
      summary: "Applies a discount.",
      claims: [
        {
          text: "`applyDiscount` takes a rate.",
          cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
        },
      ],
    };
    const { model, result } = run([bad, bad]);
    const out = await result;
    expect(out.status).toBe("abstained");
    expect(out.answer.claims).toEqual([]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]?.reasonCode).toBe("IDENTIFIER_NOT_IN_CITATION");
    expect(out.attempts).toBe(2);
    expect(model.prompts).toHaveLength(2);
  });

  it("regenerates once when more than half the claims are dropped, and answers from the better attempt", async () => {
    const { model, result } = run([
      {
        summary: "First attempt.",
        claims: [
          {
            text: "`sumPrices` returns a total.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          {
            text: "`applyDiscount` is wrong here.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          {
            text: "`applyDiscount` is wrong too.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
        ],
      },
      {
        summary: "Second attempt.",
        claims: [
          {
            text: "`sumPrices` returns a total.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          { text: "`reduce` folds the list.", cites: [{ file: "src/cart.ts", start: 2, end: 2 }] },
        ],
      },
    ]);
    const out = await result;
    expect(out.status).toBe("answered");
    expect(out.attempts).toBe(2);
    expect(out.answer.summary).toBe("Second attempt.");
    expect(out.answer.claims).toHaveLength(2);
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[1]).toContain("claims were dropped");
  });

  it("does not regenerate when at most half the claims are dropped", async () => {
    const { model, result } = run([
      {
        summary: "Mostly right.",
        claims: [
          {
            text: "`sumPrices` returns a total.",
            cites: [{ file: "src/cart.ts", start: 1, end: 3 }],
          },
          { text: "`reduce` folds the list.", cites: [{ file: "src/cart.ts", start: 2, end: 2 }] },
          { text: "`applyDiscount` is wrong.", cites: [{ file: "src/cart.ts", start: 1, end: 3 }] },
        ],
      },
    ]);
    const out = await result;
    expect(out.status).toBe("answered");
    expect(out.answer.claims).toHaveLength(2);
    expect(out.dropped).toHaveLength(1);
    expect(out.attempts).toBe(1);
    expect(model.prompts).toHaveLength(1);
  });

  it("rejects a line range outside the file", async () => {
    const model = queueModel([]);
    await expect(
      runExplain({
        model,
        workspace: fixture.ws,
        file: "src/cart.ts",
        startLine: 1,
        endLine: 99,
      }),
    ).rejects.toBeInstanceOf(RecipeInputError);
    expect(model.prompts).toHaveLength(0);
  });
});

describe("explain prompt", () => {
  it("embeds the versioned prompt file exactly, so the two cannot drift", () => {
    expect(EXPLAIN_SYSTEM).toBe(promptBody(PROMPT_FILE));
  });

  it("puts the instruction block after the system text and before the question, or omits it", async () => {
    const fixture = makeWorkspace({ "src/cart.ts": "export const x = 1;\n" });
    try {
      const answer = { summary: "s", claims: [] };
      const absent = queueModel([answer, answer]);
      const withRules = queueModel([answer, answer]);
      const base = { workspace: fixture.ws, file: "src/cart.ts", startLine: 1, endLine: 1 };
      await runExplain({ ...base, model: absent });
      await runExplain({ ...base, model: withRules, instructions: "Cite the test file." });
      expect(absent.prompts[0]?.startsWith(`${EXPLAIN_SYSTEM}\n\nAllowed citation files`)).toBe(
        true,
      );
      expect(absent.prompts[0]).not.toContain("Project instructions:");
      expect(withRules.prompts[0]).toBe(
        `${EXPLAIN_SYSTEM}\n\nProject instructions:\nCite the test file.\n\n${absent.prompts[0]?.slice(EXPLAIN_SYSTEM.length + 2)}`,
      );
    } finally {
      fixture.cleanup();
    }
  });
});
