import type { SymbolRecord } from "@fcx/index";
import { describe, expect, it } from "vitest";
import { symbolBlockText } from "../src/blocks.js";
import { packBlocks } from "../src/pack.js";
import { estimateTokens } from "../src/tokens.js";
import type { ScoredContextBlock } from "../src/types.js";

function block(name: string): ScoredContextBlock {
  return { file: `${name}.ts`, startLine: 1, endLine: 1, text: name, why: name, score: 1 };
}

describe("estimateTokens", () => {
  it("is ceil(chars / 3.5)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcdefg")).toBe(2); // 7 / 3.5
    expect(estimateTokens("abcdefgh")).toBe(3); // 8 / 3.5 rounds up
    expect(estimateTokens("x".repeat(35))).toBe(10);
  });
});

describe("packBlocks", () => {
  const item = (name: string, tokens: number) => ({ block: block(name), tokens });

  it("keeps required blocks even when they alone exceed the budget", () => {
    const packed = packBlocks([item("target", 50), item("error", 20)], [item("rest", 1)], 10);
    expect(packed.blocks.map((b) => b.why)).toEqual(["target", "error"]);
    expect(packed.usedTokens).toBe(70);
    expect(packed.droppedBlocks).toBe(1);
  });

  it("drops optional blocks that do not fit, counts them, and keeps packing", () => {
    const packed = packBlocks([], [item("a", 10), item("b", 50), item("c", 5)], 20);
    expect(packed.blocks.map((b) => b.why)).toEqual(["a", "c"]);
    expect(packed.usedTokens).toBe(15);
    expect(packed.droppedBlocks).toBe(1);
  });

  it("packs required blocks first, then optional ones in the order given", () => {
    const packed = packBlocks([item("req", 5)], [item("first", 5), item("second", 5)], 100);
    expect(packed.blocks.map((b) => b.why)).toEqual(["req", "first", "second"]);
    expect(packed.droppedBlocks).toBe(0);
  });
});

describe("symbolBlockText", () => {
  const lines = ["export function build(): void {", "  step();", "}"];
  const symbol: SymbolRecord = {
    id: 1,
    fileId: 1,
    name: "build",
    qualified: "build",
    kind: "function",
    startLine: 1,
    endLine: 3,
    signature: "export function build(): void",
    doc: "",
    exported: true,
  };

  it("gives the full body for nodes nearer than two hops", () => {
    expect(symbolBlockText(symbol, lines, 0)).toEqual({
      text: lines.join("\n"),
      startLine: 1,
      endLine: 3,
    });
    expect(symbolBlockText(symbol, lines, 1).text).toBe(lines.join("\n"));
  });

  it("gives only the signature for nodes two or more hops away", () => {
    expect(symbolBlockText(symbol, lines, 2)).toEqual({
      text: "export function build(): void",
      startLine: 1,
      endLine: 1,
    });
  });

  it("falls back to the first body line when the signature is empty", () => {
    const bare = { ...symbol, signature: "" };
    expect(symbolBlockText(bare, lines, 3).text).toBe("export function build(): void {");
  });
});
