import { join } from "node:path";
import { modelsDir } from "./models-dir.js";
import type { ModelAlias, ModelRegistryEntry } from "./types.js";

export const DEFAULT_MODELS: Record<string, ModelRegistryEntry> = {
  // Qwen2.5-7B-Instruct, Q4_K_M, from Qwen/Qwen2.5-7B-Instruct-GGUF. Split in two shards; the loader reads the second
  // shard from the same folder when the first is given.
  "qwen2.5-7b": {
    id: "qwen2.5-7b",
    path: join(modelsDir(), "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf"),
    files: [
      {
        name: "qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf",
        bytes: 3993201344,
      },
      {
        name: "qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf",
        bytes: 689872288,
      },
    ],
    ctx: 32768,
    kind: "generation",
    tier: "S",
    license: "Apache-2.0",
    quant: "Q4_K_M",
  },
  "qwen2.5-1.5b": {
    id: "qwen2.5-1.5b",
    ctx: 32768,
    kind: "generation",
    tier: "S",
    license: "Apache-2.0",
    quant: "Q4_K_M",
  },
  "qwen2.5-0.5b": {
    id: "qwen2.5-0.5b",
    ctx: 32768,
    kind: "generation",
    tier: "S",
    license: "Apache-2.0",
    quant: "Q4_K_M",
  },
  "smollm2-360m": {
    id: "smollm2-360m",
    ctx: 8192,
    kind: "generation",
    tier: "S",
    license: "Apache-2.0",
    quant: "Q8_0",
  },
  "bge-small-en-v1.5": {
    id: "bge-small-en-v1.5",
    ctx: 512,
    kind: "embedding",
    tier: "S",
    license: "Apache-2.0",
    quant: "Q8_0",
  },
};

export const ALIASES: ModelAlias[] = [
  { alias: "ggml/auto", target: "qwen2.5-7b" },
  { alias: "ggml/bge-small-en-v1.5", target: "bge-small-en-v1.5" },
];

export function resolveModelId(id: string): string {
  const alias = ALIASES.find((a) => a.alias === id);
  if (alias) return alias.target;
  if (id.startsWith("ggml/")) {
    const bare = id.slice(5);
    if (bare in DEFAULT_MODELS) return bare;
  }
  if (id in DEFAULT_MODELS) return id;
  throw new Error(`Unknown model id: ${id}`);
}

export function getModelEntry(id: string): ModelRegistryEntry {
  const resolved = resolveModelId(id);
  const entry = DEFAULT_MODELS[resolved];
  if (!entry) throw new Error(`Unknown model id: ${id}`);
  return entry;
}

export function listModels(): ModelRegistryEntry[] {
  return Object.values(DEFAULT_MODELS);
}

export function isEmbeddingModel(id: string): boolean {
  return getModelEntry(id).kind === "embedding";
}

export function isGenerationModel(id: string): boolean {
  return getModelEntry(id).kind === "generation";
}

export function defaultGenerationModel(): string {
  return "qwen2.5-7b";
}

export function defaultEmbeddingModel(): string {
  return "bge-small-en-v1.5";
}
