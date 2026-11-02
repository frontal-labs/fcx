/**
 * TEST ONLY: a model host that returns scripted outputs, for the process-level ACP test.
 *
 * The factory in runtime.ts honours `FCX_TEST_SCRIPTED_MODEL=<path to a JSON array>` only when `NODE_ENV` is
 * exactly "test" as well. Any other environment ignores the variable, so a production run never reads it.
 * The array is returned in order, one entry per `generateObject` call (router first, then the recipe's
 * candidates). Running out of entries is an error. Text generation and embeddings are not scripted.
 */
import { readFileSync } from "node:fs";
import type { ModelHost } from "@fcx/model";

export const SCRIPTED_MODEL_ENV = "FCX_TEST_SCRIPTED_MODEL";

/** The scripted host, or undefined when the test gate is not open. Throws when the script file is malformed. */
export function scriptedModelFromEnv(env: NodeJS.ProcessEnv): ModelHost | undefined {
  if (env.NODE_ENV !== "test") return undefined;
  const path = env[SCRIPTED_MODEL_ENV];
  if (path === undefined || path === "") return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`${SCRIPTED_MODEL_ENV} must name a JSON array of outputs`);
  }
  return new ScriptedModelHost(parsed);
}

export class ScriptedModelHost implements ModelHost {
  private next = 0;

  constructor(private readonly outputs: readonly unknown[]) {}

  async generateObject<T>(): Promise<{ object: T; ms: number; raw: string }> {
    if (this.next >= this.outputs.length) {
      throw new Error("scripted model ran out of outputs");
    }
    const object: unknown = this.outputs[this.next];
    this.next++;
    return { object: object as T, ms: 1, raw: JSON.stringify(object) };
  }

  async generateText(): Promise<{ text: string; ms: number }> {
    throw new Error("the scripted model does not generate text");
  }

  async embed(): Promise<{ embeddings: number[][]; dimensions: number; ms: number }> {
    throw new Error("the scripted model does not embed");
  }

  countTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  info(): { genModel: string; embedModel: string; ctx: number; rssMb: number } {
    return { genModel: "scripted", embedModel: "scripted", ctx: 0, rssMb: 0 };
  }

  async shutdown(): Promise<void> {}
}
