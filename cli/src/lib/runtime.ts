import { totalmem } from "node:os";
import type { FcSettings } from "@fcx/config";
import type { ModelHost } from "@fcx/model";
import type { ModelHostCache } from "./model-cache.js";
import { scriptedModelFromEnv } from "./scripted-model.js";

const TIER_S_MAX_BYTES = 10 * 1024 ** 3;

/** Candidate count per plan §10: 4 on tier S (≤10 GB RAM), 6 otherwise. */
export function candidateBudget(settings: FcSettings): number {
  if (typeof settings.maxCandidates === "number") return settings.maxCandidates;
  return totalmem() <= TIER_S_MAX_BYTES ? 4 : 6;
}

/** The cache installed by `fcx acp` for its process. One-shot commands never install one, so it stays undefined. */
let sharedCache: ModelHostCache | undefined;

/** Installs (or with undefined, removes) the process-wide model host cache. Only `fcx acp` calls this. */
export function useSharedModelCache(cache: ModelHostCache | undefined): void {
  sharedCache = cache;
}

/**
 * The host a recipe run uses. In `fcx acp` it comes from the process cache (one host per model id). Otherwise a
 * new host is created, and the caller owns its lifetime.
 */
export async function createModelHost(settings: FcSettings): Promise<ModelHost> {
  if (sharedCache !== undefined) return sharedCache.get(settings);
  return createFreshModelHost(settings);
}

/**
 * Creates a host that no cache owns. The test-only scripted model is honoured here, and only under NODE_ENV=test
 * (see scripted-model.ts). Maps the configured model to a registry id: `ggml/auto` (the default) means the tier's
 * default model. Loading ggml-node happens lazily, the first time a candidate is generated.
 */
export async function createFreshModelHost(settings: FcSettings): Promise<ModelHost> {
  const scripted = scriptedModelFromEnv(process.env);
  if (scripted !== undefined) return scripted;
  const { GgmlNodeModelHost } = await import("@fcx/model");
  const genModel = settings.model && settings.model !== "ggml/auto" ? settings.model : undefined;
  return new GgmlNodeModelHost({ genModel });
}
