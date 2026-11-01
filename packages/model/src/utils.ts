import { ALIASES, DEFAULT_MODELS } from "./registry";
import type { ModelAlias, ModelRegistryEntry } from "./types";

export function resolveModelId(id: string): string {
  const alias = ALIASES.find((a: ModelAlias) => a.alias === id);

  if (alias) {
    return alias.target;
  }
  if (id.startsWith("ggml/")) {
    const bare = id.slice(5);
    if (bare in DEFAULT_MODELS) {
      return bare;
    }
  }
  if (id in DEFAULT_MODELS) {
    return id;
  }

  throw new Error(`Unknown model id: ${id}`);
}

export function getModelEntry(id: string): ModelRegistryEntry {
  const resolved = resolveModelId(id);
  const entry = DEFAULT_MODELS[resolved];

  if (!entry) {
    throw new Error(`Unknown model id: ${id}`);
  }

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
  return "qwen2.5-1.5b";
}

export function defaultEmbeddingModel(): string {
  return "bge-small-en-v1.5";
}
