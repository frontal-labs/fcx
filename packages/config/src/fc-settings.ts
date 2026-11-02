import { DEFAULT_FC_EXCLUDE } from "./constants.js";
import type { Env } from "./keys.js";
import type { FcSettings, MergedSettings } from "./types.js";
import { isPlainObject } from "./util.js";

export function extractFcSettings(settings: MergedSettings, env: Env): FcSettings {
  const fc = isPlainObject(settings.fc) ? settings.fc : {};
  const escalation = isPlainObject(fc.escalation) ? fc.escalation : {};
  const index = isPlainObject(fc.index) ? fc.index : {};

  return {
    model: typeof fc.model === "string" ? fc.model : "ggml/auto",
    embeddingModel:
      typeof fc.embeddingModel === "string" ? fc.embeddingModel : "ggml/bge-small-en-v1.5",
    maxCandidates:
      typeof fc.maxCandidates === "number" || fc.maxCandidates === "auto"
        ? fc.maxCandidates
        : "auto",
    contextBudgetTokens: typeof fc.contextBudgetTokens === "number" ? fc.contextBudgetTokens : 3000,
    languages: Array.isArray(fc.languages)
      ? fc.languages.filter((l): l is string => typeof l === "string")
      : ["typescript", "python", "go", "rust"],
    index: {
      exclude: Array.isArray(index.exclude)
        ? index.exclude.filter((e): e is string => typeof e === "string")
        : DEFAULT_FC_EXCLUDE,
    },
    escalation: {
      enabled: typeof escalation.enabled === "boolean" ? escalation.enabled : true,
      provider: typeof escalation.provider === "string" ? escalation.provider : "default",
    },
    telemetry:
      env.FRONTAL_CODE_ENABLE_TELEMETRY !== "inherit"
        ? env.FRONTAL_CODE_ENABLE_TELEMETRY
        : typeof fc.telemetry === "boolean" || fc.telemetry === "inherit"
          ? fc.telemetry
          : "inherit",
  };
}
