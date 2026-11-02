/**
 * A model host for a custom GGUF file, loaded through ggml-node's `{ path }` form. It mirrors GgmlNodeModelHost's
 * generation options (isolation none, threads auto, gpu auto, the registry's context length for qwen2.5-1.5b), so
 * the base and the fine-tuned model are run with the same settings. Only generateObject is needed by the fix command.
 */
import { type GgmlNode, createGgmlNode } from "ggml-node";
import type { ModelHost } from "../../packages/model/src/index.ts";

/** Context length of the qwen2.5-1.5b registry entry (packages/model/src/registry.ts). */
const CONTEXT_SIZE = 32768;

export class PathModelHost implements Pick<ModelHost, "generateObject"> {
  private handle: GgmlNode | null = null;

  constructor(private readonly path: string) {}

  private async ensure(): Promise<GgmlNode> {
    if (this.handle) return this.handle;
    const handle = createGgmlNode({
      model: { path: this.path },
      isolation: "none",
      threads: "auto",
      gpu: "auto",
      contextSize: CONTEXT_SIZE,
    });
    await handle.ready();
    this.handle = handle;
    return handle;
  }

  async generateObject<T>(req: {
    schema: unknown;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ object: T; ms: number; raw: string }> {
    const handle = await this.ensure();
    const t0 = Date.now();
    const result = await handle.object({
      schema: req.schema as { _zod: { output: unknown } },
      prompt: req.prompt,
      temperature: req.temperature,
      maxTokens: req.maxTokens,
    });
    return { object: result.object as T, ms: Date.now() - t0, raw: result.raw };
  }

  async shutdown(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.handle.unload();
    } catch {
      // unload errors do not change the result
    }
    this.handle = null;
  }
}
