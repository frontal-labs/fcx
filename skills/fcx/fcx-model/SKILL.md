# fcx-model

## Description

Skill for fcx model hosting: ggml-node wrapper, model registry, mock host, and `ModelHost` interface. Implements the `@frontal-labs/fcx-model` package (now `fcx-model`).

## Commands

- `fcx models list` — List available models
- `fcx models pull <id>` — Pull a model GGUF
- `fcx models bench <id>` — Benchmark a model

## Model Registry

| Model | Size | Context | Tier | License | Quant |
|-------|------|---------|------|---------|-------|
| qwen2.5-1.5b | ~1.12 GB | 32768 | S | Apache-2.0 | Q4_K_M |
| qwen2.5-0.5b | ~491 MB | 32768 | S | Apache-2.0 | Q4_K_M |
| smollm2-360m | ~386 MB | 8192 | S | Apache-2.0 | Q8_0 |
| bge-small-en-v1.5 (embedding) | ~368 MB | 512 | S | MIT | Q8_0 |

## Model IDs

- `ggml/auto` → `qwen2.5-1.5b` (default generation)
- `ggml/bge-small-en-v1.5` → embedding model
- `ggml/qwen2.5-1.5b`, `ggml/qwen2.5-0.5b`, `ggml/smollm2-360m`

## ModelHost Interface

- `generateObject(schema, prompt)` — Grammar-constrained JSON via zod
- `generateText(prompt)` — Raw text generation
- `embed(input)` — Embedding vectors
- `countTokens(text)` — Token approximation
- `info()` — Model info and RSS
- `shutdown()` — Unload models

## Files

- `packages/model/src/types.ts` — `ModelHost`, `ModelError`, event types
- `packages/model/src/registry.ts` — `DEFAULT_MODELS`, `resolveModelId`, `getModelEntry`
- `packages/model/src/host.ts` — `GgmlNodeModelHost` class
- `packages/model/src/mock.ts` — `createMockModelHost`
- `packages/model/src/index.ts` — Barrel exports

## License

Apache-2.0
