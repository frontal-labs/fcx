import { describe, expect, it } from "vitest";
import {
  defaultEmbeddingModel,
  defaultGenerationModel,
  getModelEntry,
  isEmbeddingModel,
  isGenerationModel,
  listModels,
  resolveModelId,
} from "../src/registry.js";

describe("model registry", () => {
  it("resolves the ggml/ prefix to a registry id", () => {
    expect(resolveModelId("ggml/qwen2.5-1.5b")).toBe("qwen2.5-1.5b");
  });

  it("returns a registry id unchanged when it has no prefix", () => {
    expect(resolveModelId("qwen2.5-1.5b")).toBe("qwen2.5-1.5b");
  });

  it("throws for an unknown model", () => {
    expect(() => getModelEntry("ggml/does-not-exist")).toThrow(/Unknown model id/);
  });

  it("classifies generation and embedding models", () => {
    expect(isGenerationModel(defaultGenerationModel())).toBe(true);
    expect(isEmbeddingModel(defaultEmbeddingModel())).toBe(true);
    expect(isEmbeddingModel(defaultGenerationModel())).toBe(false);
  });

  it("lists every entry with an id and a context length", () => {
    const models = listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.id).not.toBe("");
      expect(model.ctx).toBeGreaterThan(0);
    }
  });
});
