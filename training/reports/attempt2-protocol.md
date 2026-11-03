# Attempt 2 protocol (fix-diagnostic LoRA, pre-registered)

Written 2026-11-02 before any attempt-2 data generation, collection, training or evaluation run.
Attempt 1 is recorded in docs/DECISIONS.md (2026-11-02 entries): 192 train examples, 38 validation, test base 37.8%
vs fine-tuned 16.7% (fence-stripped), not shipped.

## 1. Data

- Generator: `training/gen_tasks.py`. Existing 30 families are unchanged. New families are added with identifier pools
  disjoint from the test pool (new train families use the `train` pool, new validation families use the `validation`
  pool, the same pools the existing families of those splits use).
- Family split rule (unchanged): a family appears in exactly one split.
- **Interpretation (decided before the run):** "train tasks across the existing 30 families" cannot include the 10 test
  families or the 5 validation families, because family-disjointness is a hard rule. The existing families used for
  train are the 15 train-assigned ones.
- New families, 15 in total (at least 10 required):
  - Train (12): ann-tuple-length, ann-record-value, ann-nested-array, ann-optional-union, typo-enum-member,
    typo-array-method, imp-type-alias, imp-enum-member, ret-void-value, ret-union-literal, ret-optional-undefined,
    arg-callback-return.
  - Validation (3): typo-object-method, imp-generic-type, arg-object-second-field.
- Train: 27 families x 60 instances = **1,620 tasks** (target at least 1,500). Validation: 8 families x 12 = **96 tasks**
  (enlarged from 60; the 3 new validation families are not in train).
- Test: **unchanged**. The 150 test tasks in `training/tasks/test/` are not regenerated and not read. The generator
  change does not write the test directory.
- Known limitation: the test split was already used by attempt 1 for its held-out result, so it is not fresh for this
  attempt. The result is a re-measurement on the same test tasks, not a new held-out set.

## 2. Collection

- Same pipeline as attempt 1: `training/src/collect.ts` on the local model (`ggml/auto` via ggml-node), splits train and
  validation only. Verified examples only. Deduplication by normalized prompt, within each split.
- Completion form: `{"edits":[{"file":...,"search":...,"replace":...}]}` with compact JSON and no code fence. This is the
  edit schema's key order (`file`, `search`, `replace`) from `packages/recipes/src/engine.ts`.
- Output: `training/data/fix-diagnostic-v2/train.jsonl`, `valid.jsonl`, `stats.json` (counts per category).

## 3. Training

- Config: `training/configs/fix-diagnostic-v2.yaml`, a copy of attempt 1's config with the new data and run paths.
- Fixed before the run: rank 8, learning rate 5e-5, iters 600, batch 2, save every 100 iterations, steps_per_eval 100.
- Also fixed before the run, one change from attempt 1: `val_batches: -1` (use the whole validation split, not 25
  batches), so validation loss is not a noisy subsample. Reason: checkpoint selection should use all validation data.
  This is a choice made before any test result.
- Other settings unchanged from attempt 1: scale 20, dropout 0, all 28 layers, attention and MLP projections,
  max_seq_length 2048, grad_checkpoint, mask_prompt, seed 0.
- Checkpoint selection: among the checkpoints at iterations 100, 200, 300, 400, 500, 600, select the one with the lowest
  mlx-lm validation loss. **No test result is used for selection.**

## 4. Evaluation

- Same scoring as attempt 1: `training/src/capture-test-prompts.ts` (prompts captured on the test split),
  `training/src/generate_mlx.py` (MLX, temperature 0.2, seed 0, max_tokens 768, chat template as in training),
  `training/src/score-mlx.ts` with one candidate.
- Headline parse: **fence-stripped** (the user's instruction; base wraps every output in a fence). Strict parse is
  reported as sensitivity only.
- Models evaluated once each on the held-out TEST split: the base model and the selected checkpoint.
- Outputs in `training/eval-attempt2/`. Statistics: Wilson 95% intervals, exact two-sided sign test on discordant pairs,
  same formulas as `training/src/mlx_report.py`.

## 5. Verdict rule (decided before the result)

- The fine-tuned model is **shipped** only if its test pass rate on the model set is higher than base's and the paired
  exact sign test gives p < 0.05. Otherwise it is **not shipped**.
- Shipping also needs a GGUF, which needs llama.cpp, which the owner has not approved. So a model that meets the rule
  is reported as "eligible, not shipped (GGUF blocked)".

## 6. Rules

- No hyperparameter is tuned after seeing a test result. If the first pass shows a problem, a change may be made only on
  validation metrics, and every such change is logged below with its reason.
- No `bun install`, no `bun add`, no state-changing git commands, no downloads beyond the cached base model.

## 7. Change log

(entries are added here during the run, dated, with the reason)
- 2026-11-02: protocol written. No run yet.
- 2026-11-02, data generation: `gen_tasks.py` extended with 15 new families (12 train, 3 validation); train 20 -> 60
  per family; run as `--splits train,validation`. Result: train 1,620 tasks, validation 96 tasks. Test directory
  unchanged (150 files, checksum matched before and after the regeneration). Every train and validation task has a
  type error on its target line (checked with the TypeScript compiler API, 1,716 of 1,716).
- 2026-11-02, collection BLOCKED (no example data produced): the first collection run stopped without output while
  disk space was fluctuating (free space ranged from 117 MB to 3.5 GB). Its log and the scratchpad were lost in the same
  period. Re-run then failed at import: `ggml-node` is incomplete in `packages/model/node_modules/ggml-node` (no
  `dist/`), and the root `node_modules` lacks it. Restoring requires `bun install`, which this protocol forbids, so it
  needs the owner's approval. No training, evaluation or verdict has been produced for attempt 2.
