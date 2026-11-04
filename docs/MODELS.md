# Models

fcx uses one generation model by default: Qwen2.5-7B-Instruct, Q4_K_M (about 4.7 GB in two shards).

Why the change: on the fix-test eval, the 1.5B model passed 0/8, the 3B model 2/8, and the 7B model 5/8. The project
previously ruled out models of 3B and larger. The project owner delegated the model choice on 2026-11-04, and the
choice was made for quality. The 1.5B model stays available as `qwen2.5-1.5b`.

The 7B model is not in ggml-node's registry, so it is loaded from a local GGUF file. The repository's `models/` folder (gitignored) must contain
`qwen2.5-7b-instruct-q4_k_m-00001-of-00002.gguf` and `qwen2.5-7b-instruct-q4_k_m-00002-of-00002.gguf`, from Hugging Face (repo `Qwen/Qwen2.5-7B-Instruct-GGUF`).
The registry entry in `packages/model/src/registry.ts` holds the path to the first shard.

## Registry (`@fcx/model`)

| Model | Size | Context | Tier | License | Quant |
|-------|------|---------|------|---------|-------|
| qwen2.5-7b | ~4.7 GB | 32768 | S | Apache-2.0 | Q4_K_M (local, 2 shards) |
| qwen2.5-1.5b | ~1.12 GB | 32768 | S | Apache-2.0 | Q4_K_M |
| qwen2.5-0.5b | ~491 MB | 32768 | S | Apache-2.0 | Q4_K_M |
| smollm2-360m | ~386 MB | 8192 | S | Apache-2.0 | Q8_0 |
| bge-small-en-v1.5 (embedding) | ~368 MB | 512 | S | Apache-2.0 | Q8_0 |

## Model IDs

- `ggml/auto` → `qwen2.5-7b` (default generation)
- `ggml/bge-small-en-v1.5` → embedding model
- `ggml/qwen2.5-7b`, `ggml/qwen2.5-1.5b`, `ggml/qwen2.5-0.5b`, `ggml/smollm2-360m`

## ModelHost Interface

- `generateObject(schema, prompt)` — Grammar-constrained JSON output via zod
- `generateText(prompt)` — Raw text generation
- `embed(input)` — Embedding vectors
- `countTokens(text)` — Token approximation (ceil(chars / 3.5))
- `info()` — Model info and RSS
- `shutdown()` — Unload models

## Tier S (≤ 10 GB RAM)

- Generation model: Qwen2.5-7B-Instruct, 4-bit (~5 GB weights)
- Max candidates: 4

## Fine-tuning

LoRA on the base model, merged into GGUF for shipping. See `training/`.
