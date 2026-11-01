# fcx training directory
# Distillation data collection, fine-tuning, GGUF export.
# Python is allowed here only; nothing at runtime depends on Python.

## Structure
- data/       Distillation training data (verified examples per recipe)
- configs/    Training configs (LoRA hyperparameters per language family)
- export/     Merged GGUF export output

## Data format
{ "recipe": "...", "prompt_system": "...", "prompt_user": "...", "output_json": "...", "repo": "...", "commit": "...", "lang": "..." }
