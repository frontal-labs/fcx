#!/usr/bin/env bash
# Reproduces the fix-diagnostic fine-tune end to end, from one command:
#   1. generate tasks (train, validation, test)            2. collect examples from the current model (train, validation only)
#   3. LoRA training with mlx-lm (training/configs/fix-diagnostic.yaml)
#   4. fuse the adapter into safetensors                    5. GGUF export and quantization, only if the llama.cpp tools exist
#   6. evaluate base and fine-tuned on the TEST split       7. write training/reports/<date>.json
#
# Requires: training/.venv with mlx-lm (see docs/DECISIONS.md), bun, and network on the first run (model download).
# The test split is read only in steps 6 and 7. Nothing tunes on it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PY="$ROOT/training/.venv/bin/python"
RUN="$ROOT/training/runs/fix-diagnostic"
DATA="$ROOT/training/data/fix-diagnostic"
REPORTS="$ROOT/training/reports"
BASE_HF="Qwen/Qwen2.5-1.5B-Instruct"
DATE="$(date +%F)"
mkdir -p "$RUN" "$REPORTS"

echo "== 1. tasks"
"$PY" training/gen_tasks.py

echo "== 2. collect (train, validation)"
bun training/src/collect.ts --out "$DATA"

echo "== 3. train (mlx-lm LoRA)"
"$PY" -m mlx_lm lora --config training/configs/fix-diagnostic.yaml 2>&1 | tee "$RUN/train.log"

echo "== 4. fuse"
"$PY" -m mlx_lm fuse --model "$BASE_HF" --adapter-path "$RUN/adapters" --save-path "$RUN/fused"

echo "== 5. evaluate base on test"
bun training/src/evaluate.ts --model base --label base --split test --out "$REPORTS/base-test-$DATE.json"

echo "== 6. GGUF export (skipped when the llama.cpp tools are missing)"
GGUF="$RUN/fused-q4_k_m.gguf"
set +e
bash training/export_gguf.sh "$RUN/fused" "$GGUF"
EXPORT_STATUS=$?
set -e
if [ "$EXPORT_STATUS" -eq 0 ]; then
  echo "== 7. evaluate fine-tuned on test"
  bun training/src/evaluate.ts --model "$GGUF" --label finetuned --split test --out "$REPORTS/finetuned-test-$DATE.json"
else
  echo "GGUF export not run (exit $EXPORT_STATUS). Fine-tuned evaluation skipped."
fi

echo "== 8. report"
"$PY" training/report.py --date "$DATE"
