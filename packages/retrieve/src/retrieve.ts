import { resolve } from "node:path";
import {
  type Embedder,
  type IndexStore,
  type SymbolRecord,
  indexWorkspace,
  openIndex,
} from "@fcx/index";
import { SourceCache, symbolBlockText } from "./blocks.js";
import {
  BM25_LIMIT,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  FUSED_LIMIT,
  RRF_K,
  VECTOR_LIMIT,
} from "./constants.js";
import { type Reached, type SeedHit, expandGraph } from "./graph.js";
import { compareText } from "./order.js";
import { type PackItem, packBlocks } from "./pack.js";
import { declaredPackages } from "./packages.js";
import { buildQueryText } from "./query.js";
import { type FusedHit, reciprocalRankFusion } from "./rrf.js";
import { storeGraph } from "./store-graph.js";
import { resolveTarget, workspaceRelative } from "./target.js";
import { estimateTokens } from "./tokens.js";
import type { ContextBundle, RetrieveOptions, RetrieveTask, ScoredContextBlock } from "./types.js";

const NO_ERROR_FILE = "(error text)";

interface Location {
  readonly id: number;
  readonly path: string;
  readonly line: number;
}

/** Path and line of a symbol, for deterministic tie-breaking. Unknown symbols sort first. */
function locator(store: IndexStore): (symbolId: number) => Location {
  const cache = new Map<number, Location>();
  return (symbolId) => {
    const cached = cache.get(symbolId);
    if (cached !== undefined) {
      return cached;
    }
    const symbol = store.symbolById(symbolId);
    const file = symbol === undefined ? undefined : store.fileById(symbol.fileId);
    const location: Location = {
      id: symbolId,
      path: file?.path ?? "",
      line: symbol?.startLine ?? 0,
    };
    cache.set(symbolId, location);
    return location;
  };
}

function compareLocations(a: Location, b: Location): number {
  return compareText(a.path, b.path) || a.line - b.line || a.id - b.id;
}

/**
 * Indexes the workspace (incrementally, unless `skipIndex`), then assembles the context bundle for
 * `task`: seeds, hybrid ranking, graph expansion, and budget packing (plan section 8.3).
 * The result is deterministic for the same index and input.
 */
export async function retrieve(
  task: RetrieveTask,
  options: RetrieveOptions,
): Promise<ContextBundle> {
  const workspace = resolve(task.workspace);
  const notes: string[] = [];
  if (options.skipIndex !== true) {
    const summary = await indexWorkspace(workspace, {
      dbPath: options.dbPath,
      exclude: options.exclude,
      embedder: options.embedder,
    });
    notes.push(...summary.warnings);
  }
  const store = openIndex(options.dbPath);
  try {
    return await assemble(store, workspace, task, options, notes);
  } finally {
    store.close();
  }
}

async function assemble(
  store: IndexStore,
  workspace: string,
  task: RetrieveTask,
  options: RetrieveOptions,
  notes: string[],
): Promise<ContextBundle> {
  const budget = options.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const target = resolveTarget(store, task, workspace);
  if (target === undefined) {
    notes.push("no target symbol matched the task");
  }

  const ranking = await rankCandidates(store, buildQueryText(task), options.embedder, notes);
  const locate = locator(store);
  const fused = [...ranking.fused].sort(
    (a, b) => b.score - a.score || compareLocations(locate(a.symbolId), locate(b.symbolId)),
  );
  const hits: SeedHit[] = fused.slice(0, FUSED_LIMIT).map((hit, index) => ({
    symbolId: hit.symbolId,
    score: hit.score,
    rank: index + 1,
  }));
  const targetScore = fused[0]?.score ?? 1 / (RRF_K + 1);
  const reached = expandGraph(storeGraph(store), target?.id, targetScore, hits);

  const sources = new SourceCache(workspace);
  const symbolOf = new Map<ScoredContextBlock, SymbolRecord>();
  const required: PackItem[] = [];
  const optional: PackItem[] = [];
  let dropped = 0;

  const addSymbol = async (
    symbol: SymbolRecord,
    hops: number,
    why: string,
    score: number,
  ): Promise<PackItem | undefined> => {
    const file = store.fileById(symbol.fileId);
    const lines = file === undefined ? undefined : await sources.lines(file.path);
    if (file === undefined || lines === undefined) {
      dropped += 1;
      return undefined;
    }
    const text = symbolBlockText(symbol, lines, hops);
    const block: ScoredContextBlock = {
      file: file.path,
      startLine: text.startLine,
      endLine: text.endLine,
      text: text.text,
      why,
      score,
    };
    symbolOf.set(block, symbol);
    return { block, tokens: estimateTokens(text.text) };
  };

  const siblingRecord = target === undefined ? undefined : pickSibling(store, target, reached);

  if (target !== undefined) {
    const item = await addSymbol(target, 0, "target symbol", targetScore);
    if (item !== undefined) {
      required.push(item);
    }
  }

  let errorBlock: ScoredContextBlock | undefined;
  if (task.errorText !== undefined && task.errorText.trim().length > 0) {
    const line = task.line ?? 1;
    errorBlock = {
      file: task.file === undefined ? NO_ERROR_FILE : workspaceRelative(workspace, task.file),
      startLine: line,
      endLine: line,
      text: task.errorText,
      why: "error text",
      score: targetScore,
    };
    required.push({ block: errorBlock, tokens: estimateTokens(task.errorText) });
  }

  if (siblingRecord !== undefined) {
    const sibling = reached.get(siblingRecord.id);
    const item = await addSymbol(siblingRecord, 0, "sibling example", sibling?.score ?? 0);
    if (item !== undefined) {
      required.push(item);
    }
  }

  const excluded = new Set<number>([target?.id, siblingRecord?.id].filter(isNumber));
  const rest = [...reached.values()]
    .filter((entry) => !excluded.has(entry.symbolId))
    .sort((a, b) => b.score - a.score || compareLocations(locate(a.symbolId), locate(b.symbolId)));
  for (const entry of rest) {
    const symbol = store.symbolById(entry.symbolId);
    if (symbol === undefined) {
      continue;
    }
    const item = await addSymbol(symbol, entry.hops, whyText(entry), entry.score);
    if (item !== undefined) {
      optional.push(item);
    }
  }

  const packed = packBlocks(required, optional, budget);
  dropped += packed.droppedBlocks;
  const includedSymbols = packed.blocks
    .map((block) => symbolOf.get(block))
    .filter((symbol): symbol is SymbolRecord => symbol !== undefined);
  const paths = new Set(
    packed.blocks
      .filter((block) => symbolOf.has(block) || (block === errorBlock && task.file !== undefined))
      .map((block) => block.file),
  );
  const symbolsInScope = new Set(includedSymbols.map((symbol) => symbol.qualified));

  return {
    blocks: packed.blocks,
    allowLists: {
      paths: [...paths].sort(compareText),
      symbolsInScope: [...symbolsInScope].sort(compareText),
      importablePackages: await declaredPackages(workspace),
    },
    metadata: {
      vectorSide: ranking.vectorSide,
      budgetTokens: budget,
      usedTokens: packed.usedTokens,
      droppedBlocks: dropped,
      targetFound: target !== undefined,
      notes,
    },
  };
}

function isNumber(value: number | undefined): value is number {
  return value !== undefined;
}

function whyText(entry: Reached): string {
  return entry.hops === 0 ? entry.why : `${entry.why} (hop ${entry.hops})`;
}

/**
 * The sibling example: a symbol of the target's kind in the target's file, or else in the reached
 * set. Among candidates the highest-scored wins, then the earliest line.
 */
function pickSibling(
  store: IndexStore,
  target: SymbolRecord,
  reached: ReadonlyMap<number, Reached>,
): SymbolRecord | undefined {
  const sameFile = store
    .symbolsInFile(target.fileId)
    .filter((symbol) => symbol.id !== target.id && symbol.kind === target.kind);
  const pool =
    sameFile.length > 0
      ? sameFile
      : [...reached.keys()]
          .map((id) => store.symbolById(id))
          .filter(
            (symbol): symbol is SymbolRecord =>
              symbol !== undefined && symbol.id !== target.id && symbol.kind === target.kind,
          );
  const scoreOf = (symbol: SymbolRecord): number => reached.get(symbol.id)?.score ?? 0;
  return [...pool].sort(
    (a, b) => scoreOf(b) - scoreOf(a) || a.startLine - b.startLine || a.id - b.id,
  )[0];
}

interface Ranking {
  readonly fused: FusedHit[];
  readonly vectorSide: boolean;
}

async function rankCandidates(
  store: IndexStore,
  queryText: string,
  embedder: Embedder | undefined,
  notes: string[],
): Promise<Ranking> {
  const lists: number[][] = [];
  if (queryText.length > 0) {
    lists.push(store.search(queryText, BM25_LIMIT).map((hit) => hit.symbolId));
  } else {
    notes.push("empty query: BM25 side skipped");
  }
  let vectorSide = false;
  if (embedder === undefined) {
    notes.push("no embedder: vector side skipped, ranking is BM25 only");
  } else {
    const vector = await embedQuery(store, queryText, embedder, notes);
    if (vector !== undefined) {
      lists.push(store.vectorSearch(vector, VECTOR_LIMIT).map((hit) => hit.symbolId));
      vectorSide = true;
    }
  }
  return { fused: reciprocalRankFusion(lists), vectorSide };
}

async function embedQuery(
  store: IndexStore,
  queryText: string,
  embedder: Embedder,
  notes: string[],
): Promise<Float32Array | undefined> {
  const model = `${embedder.model}:${embedder.dimensions}`;
  if (store.getMeta("embed_model") !== model) {
    notes.push(`vector side skipped: index vectors were not built with ${model}`);
    return undefined;
  }
  if (store.chunksMissingVectors(1).length > 0) {
    notes.push("vector side skipped: some chunks have no vectors");
    return undefined;
  }
  if (queryText.length === 0) {
    return undefined;
  }
  let vectors: readonly Float32Array[];
  try {
    vectors = await embedder.embed([queryText]);
  } catch (error) {
    notes.push(`vector side skipped: query embedding failed: ${String(error)}`);
    return undefined;
  }
  const vector = vectors[0];
  if (vector === undefined || vector.length !== embedder.dimensions) {
    notes.push("vector side skipped: query embedding has the wrong dimension");
    return undefined;
  }
  return vector;
}
