#!/usr/bin/env bash
# Converts the fused safetensors model to GGUF and quantizes it to Q4_K_M with llama.cpp.
# Usage: training/export_gguf.sh <fused dir> <out .gguf>
# Needs a llama.cpp checkout with a built llama-quantize, given by LLAMA_CPP_DIR:
#   $LLAMA_CPP_DIR/convert_hf_to_gguf.py and $LLAMA_CPP_DIR/build/bin/llama-quantize
# Exit 0: GGUF written. Exit 2: tools missing, nothing written (run.sh then skips the fine-tuned evaluation).
# Exit 1: a tool ran and failed.
set -euo pipefail

FUSED="${1:?fused dir}"
OUT="${2:?out gguf}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/training/.venv/bin/python"
LLAMA_CPP_DIR="${LLAMA_CPP_DIR:-}"

if [ -z "$LLAMA_CPP_DIR" ] || [ ! -f "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" ] || [ ! -x "$LLAMA_CPP_DIR/build/bin/llama-quantize" ]; then
  echo "llama.cpp tools not found (set LLAMA_CPP_DIR to a checkout with convert_hf_to_gguf.py and build/bin/llama-quantize)."
  echo "No GGUF was produced. Stopping at the fused safetensors in $FUSED."
  exit 2
fi

F16="${OUT%.gguf}.f16.gguf"
"$PY" "$LLAMA_CPP_DIR/convert_hf_to_gguf.py" "$FUSED" --outtype f16 --outfile "$F16"
"$LLAMA_CPP_DIR/build/bin/llama-quantize" "$F16" "$OUT" Q4_K_M
rm -f "$F16"
shasum -a 256 "$OUT"
