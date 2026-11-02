import type { ScoredContextBlock } from "./types.js";

export interface PackItem {
  readonly block: ScoredContextBlock;
  readonly tokens: number;
}

export interface PackResult {
  /** Required blocks first, in the order given, then the optional blocks that fit. */
  readonly blocks: ScoredContextBlock[];
  readonly usedTokens: number;
  /** Optional blocks that did not fit. */
  readonly droppedBlocks: number;
}

/**
 * Packs blocks into a token budget (plan section 8.3, step 6). Required items are always kept,
 * even when they alone exceed the budget. Optional items are taken in the order given (best
 * first). An item that does not fit is dropped and counted, and packing continues with the next
 * one, so a smaller later item can still fit.
 */
export function packBlocks(
  required: readonly PackItem[],
  optional: readonly PackItem[],
  budgetTokens: number,
): PackResult {
  const blocks: ScoredContextBlock[] = required.map((item) => item.block);
  let usedTokens = required.reduce((sum, item) => sum + item.tokens, 0);
  let droppedBlocks = 0;
  for (const item of optional) {
    if (usedTokens + item.tokens > budgetTokens) {
      droppedBlocks += 1;
      continue;
    }
    usedTokens += item.tokens;
    blocks.push(item.block);
  }
  return { blocks, usedTokens, droppedBlocks };
}
