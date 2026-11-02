"""Step 2 of the MLX held-out comparison: one completion per model prompt on the TEST split.

Loads Qwen/Qwen2.5-1.5B-Instruct from the local Hugging Face cache (the caller sets HF_HUB_OFFLINE=1, so nothing is
downloaded), optionally with the LoRA adapter, and generates with the chat template that mlx_lm lora used for training:
the engine prompt is one user message, and the generation prompt is added after it.

Usage (from the repository root):
  HF_HUB_OFFLINE=1 training/.venv/bin/python -I training/src/generate_mlx.py --label base
  HF_HUB_OFFLINE=1 training/.venv/bin/python -I training/src/generate_mlx.py --label finetuned \
      --adapter training/runs/fix-diagnostic/adapters
Writes training/eval-mlx/<label>-completions.jsonl with {id, completion, generation_tokens}.
"""

import argparse
import json
import os
import time

import mlx.core as mx
from mlx.utils import tree_flatten
from mlx_lm import generate, load
from mlx_lm.sample_utils import make_sampler

BASE = "Qwen/Qwen2.5-1.5B-Instruct"
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--prompts", default=os.path.join(ROOT, "training/eval-mlx/test-prompts.jsonl"))
    ap.add_argument("--out", default=None)
    ap.add_argument("--temp", type=float, default=0.2)
    ap.add_argument("--max-tokens", type=int, default=768)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()
    out = args.out or os.path.join(ROOT, "training/eval-mlx", f"{args.label}-completions.jsonl")

    rows = []
    with open(args.prompts) as fh:
        for line in fh:
            row = json.loads(line)
            if row["kind"] == "model":
                rows.append(row)

    model, tokenizer = load(BASE, adapter_path=args.adapter)
    dtypes = sorted({str(p.dtype) for _, p in tree_flatten(model.parameters())})
    sampler = make_sampler(temp=args.temp)
    mx.random.seed(args.seed)

    t0 = time.time()
    with open(out, "w") as fh:
        for i, row in enumerate(rows, 1):
            messages = [{"role": "user", "content": row["prompt"]}]
            text = tokenizer.apply_chat_template(messages, add_generation_prompt=True, tokenize=False)
            completion = generate(model, tokenizer, prompt=text, max_tokens=args.max_tokens, sampler=sampler)
            n_tokens = len(tokenizer.encode(completion))
            fh.write(json.dumps({"id": row["id"], "completion": completion, "generation_tokens": n_tokens}) + "\n")
            fh.flush()
            print(f"[{i}/{len(rows)}] {row['id']} tokens~{n_tokens}", flush=True)
    print(
        json.dumps(
            {
                "label": args.label,
                "adapter": args.adapter,
                "prompts": len(rows),
                "temp": args.temp,
                "max_tokens": args.max_tokens,
                "seed": args.seed,
                "param_dtypes": dtypes,
                "seconds": round(time.time() - t0, 1),
                "out": out,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
