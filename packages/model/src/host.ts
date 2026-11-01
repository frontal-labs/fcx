import {
  type GgmlNode,
  type GgmlNodeOptions,
  type ModelId,
  createGgmlNode,
  isGgmlNodeError,
} from "ggml-node";
import { createMockGgmlNode } from "ggml-node/testing";
import {
  defaultEmbeddingModel,
  defaultGenerationModel,
  getModelEntry,
  isEmbeddingModel,
  isGenerationModel,
} from "./registry.js";
import {
  type GgmlNodeModelHostOptions,
  ModelError,
  type ModelHost,
  type ModelHostEvent,
  ModelLoadError,
} from "./types.js";

const TOKEN_APPROXIMATION = 3.5;

function approxTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_APPROXIMATION);
}

export class GgmlNodeModelHost implements ModelHost {
  private genHandle: GgmlNode | null = null;
  private embedHandle: GgmlNode | null = null;
  private genModelId: string;
  private embedModelId: string;
  private eventCallback?: (event: ModelHostEvent) => void;

  constructor(opts: GgmlNodeModelHostOptions = {}) {
    this.genModelId = opts.genModel ?? defaultGenerationModel();
    this.embedModelId = opts.embedModel ?? defaultEmbeddingModel();

    if (!isGenerationModel(this.genModelId)) {
      throw new ModelError(`Model ${this.genModelId} is not a generation model`, "INVALID_MODEL");
    }
    if (!isEmbeddingModel(this.embedModelId)) {
      throw new ModelError(`Model ${this.embedModelId} is not an embedding model`, "INVALID_MODEL");
    }

    if (opts.mock) {
      this.genHandle = createMockGgmlNode({ kind: "generation", model: this.genModelId });
      this.embedHandle = createMockGgmlNode({ kind: "embedding", model: this.embedModelId });
    }
  }

  set onEvent(cb: ((event: ModelHostEvent) => void) | undefined) {
    this.eventCallback = cb;
  }

  private async ensureGen(): Promise<GgmlNode> {
    if (this.genHandle) return this.genHandle;
    try {
      const entry = getModelEntry(this.genModelId);
      const opts: GgmlNodeOptions = {
        model: (entry.path ?? this.genModelId) as ModelId,
        isolation: "none",
        threads: "auto",
        gpu: "auto",
        contextSize: entry.ctx,
      };
      this.genHandle = createGgmlNode(opts);
      await this.genHandle.ready();
      this.eventCallback?.({ type: "load", model: this.genModelId, ms: 0 });
      return this.genHandle;
    } catch (err) {
      throw new ModelLoadError(
        `Failed to load generation model ${this.genModelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureEmbed(): Promise<GgmlNode> {
    if (this.embedHandle) return this.embedHandle;
    try {
      const entry = getModelEntry(this.embedModelId);
      const opts: GgmlNodeOptions = {
        model: (entry.path ?? this.embedModelId) as ModelId,
        isolation: "none",
        threads: "auto",
        gpu: "auto",
        contextSize: entry.ctx,
      };
      this.embedHandle = createGgmlNode(opts);
      await this.embedHandle.ready();
      this.eventCallback?.({ type: "load", model: this.embedModelId, ms: 0 });
      return this.embedHandle;
    } catch (err) {
      throw new ModelLoadError(
        `Failed to load embedding model ${this.embedModelId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async generateObject<T>(req: {
    schema: unknown;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ object: T; ms: number; raw: string }> {
    const handle = await this.ensureGen();
    const t0 = Date.now();
    const result = await handle.object({
      schema: req.schema as { _zod: { output: unknown } },
      prompt: req.prompt,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    });
    const ms = Date.now() - t0;
    this.eventCallback?.({ type: "request", model: this.genModelId, ms });
    return { object: result.object as T, ms, raw: result.raw };
  }

  async generateText(req: {
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    signal?: AbortSignal;
  }): Promise<{ text: string; ms: number }> {
    const handle = await this.ensureGen();
    const t0 = Date.now();
    const result = await handle.generate({
      prompt: req.prompt,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
      stop: req.stop,
      signal: req.signal,
    });
    const ms = Date.now() - t0;
    this.eventCallback?.({ type: "request", model: this.genModelId, ms });
    return { text: result.text, ms };
  }

  async embed(
    input: string[],
  ): Promise<{ embeddings: number[][]; dimensions: number; ms: number }> {
    const handle = await this.ensureEmbed();
    const t0 = Date.now();
    const result = await handle.embed({ input });
    const ms = Date.now() - t0;
    this.eventCallback?.({ type: "request", model: this.embedModelId, ms });
    return { embeddings: result.embeddings, dimensions: result.dimensions, ms };
  }

  countTokens(text: string): number {
    return approxTokens(text);
  }

  info(): { genModel: string; embedModel: string; ctx: number; rssMb: number } {
    const genEntry = getModelEntry(this.genModelId);
    return {
      genModel: this.genModelId,
      embedModel: this.embedModelId,
      ctx: Math.min(genEntry.ctx, 4096),
      rssMb: 0,
    };
  }

  async shutdown(): Promise<void> {
    if (this.genHandle) {
      try {
        await this.genHandle.unload();
      } catch {
        // swallow unload errors
      }
      this.genHandle = null;
    }
    if (this.embedHandle) {
      try {
        await this.embedHandle.unload();
      } catch {
        // swallow unload errors
      }
      this.embedHandle = null;
    }
  }
}
