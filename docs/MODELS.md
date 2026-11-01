# Models

fcx uses one generation model of about 1.5B parameters. No 3B or larger models.

## Registry (`@frontal-labs/fcx-model`)

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

- `generateObject(schema, prompt)` — Grammar-constrained JSON output via zod
- `generateText(prompt)` — Raw text generation
- `embed(input)` — Embedding vectors
- `countTokens(text)` — Token approximation (ceil(chars / 3.5))
- `info()` — Model info and RSS
- `shutdown()` — Unload models

## Tier S (≤ 10 GB RAM)

- Generation model: ~1.5B coder-class, 4-bit (~1 GB weights)
- Max candidates: 4

## Fine-tuning

LoRA on the base model, merged into GGUF for shipping. See `training/`.
