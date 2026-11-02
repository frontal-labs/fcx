"""Step 4 of the MLX held-out comparison: builds training/reports/mlx-test-<date>.json from the prompt capture and the
four score files. Adds Wilson 95% intervals, a paired comparison on the model set (exact sign test on discordant
pairs), and the commands used. It does not decide which model ships.

Usage: python3 training/src/mlx_report.py --date 2026-11-02 --commands <file with the commands, one per line>
"""

import argparse
import json
import math
import os
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EVAL = os.path.join(ROOT, "training", "eval-mlx")
Z = 1.96


def wilson(passed, total):
    if total == 0:
        return [0.0, 0.0]
    p = passed / total
    denom = 1 + Z * Z / total
    centre = (p + Z * Z / (2 * total)) / denom
    half = Z * math.sqrt(p * (1 - p) / total + Z * Z / (4 * total * total)) / denom
    return [max(0.0, centre - half), min(1.0, centre + half)]


def prop(passed, total):
    return {
        "passed": passed,
        "total": total,
        "rate": round(passed / total, 4) if total else 0.0,
        "wilson95": [round(x, 4) for x in wilson(passed, total)],
    }


def exact_sign_test(b, c):
    """Two-sided exact binomial test on discordant pairs: b = only base passed, c = only finetuned passed."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2**n)
    return min(1.0, 2 * tail)


def load_scores(label, parse):
    with open(os.path.join(EVAL, f"{label}-scores-{parse}.json")) as fh:
        return json.load(fh)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--commands", required=True)
    args = ap.parse_args()

    with open(os.path.join(EVAL, "test-prompts.jsonl")) as fh:
        prompts = [json.loads(line) for line in fh if line.strip()]
    kinds = {}
    for p in prompts:
        kinds[p["kind"]] = kinds.get(p["kind"], 0) + 1
    model_ids = [p["id"] for p in prompts if p["kind"] == "model"]
    compiler_ids = [p["id"] for p in prompts if p["kind"] == "compiler"]
    model_cats = {p["id"]: p["category"] for p in prompts}

    parses = {}
    for parse in ["strict", "fence-stripped"]:
        per_model = {}
        for label in ["base", "finetuned"]:
            d = load_scores(label, parse)
            scores = {s["id"]: s for s in d["scores"]}
            model_rows = [scores[i] for i in model_ids]
            comp_rows = [scores[i] for i in compiler_ids]
            cats = sorted({model_cats[i] for i in model_ids})
            by_cat = {}
            for c in cats:
                rs = [scores[i] for i in model_ids if model_cats[i] == c]
                by_cat[c] = prop(sum(r["pass"] for r in rs), len(rs))
            per_model[label] = {
                "modelComparison": prop(sum(r["pass"] for r in model_rows), len(model_rows)),
                "byCategory": by_cat,
                "compilerResolved": prop(sum(r["pass"] for r in comp_rows), len(comp_rows)),
                "overallIncludingCompiler": prop(
                    sum(r["pass"] for r in model_rows + comp_rows), len(model_rows) + len(comp_rows)
                ),
                "diagnostics": d["diagnostics"],
                "acceptedFromModel": d["acceptedFromModel"],
                "scoresFile": f"training/eval-mlx/{label}-scores-{parse}.json",
                "pass": {i: scores[i]["pass"] for i in model_ids},
            }
        b_pass = per_model["base"]["pass"]
        f_pass = per_model["finetuned"]["pass"]
        only_base = sum(1 for i in model_ids if b_pass[i] and not f_pass[i])
        only_ft = sum(1 for i in model_ids if f_pass[i] and not b_pass[i])
        n = len(model_ids)
        base_p = per_model["base"]["modelComparison"]
        ft_p = per_model["finetuned"]["modelComparison"]
        diff_pts = (ft_p["rate"] - base_p["rate"]) * 100
        parses[parse] = {
            "models": {k: {kk: vv for kk, vv in v.items() if kk != "pass"} for k, v in per_model.items()},
            "pairedModelComparison": {
                "n": n,
                "onlyBasePassed": only_base,
                "onlyFinetunedPassed": only_ft,
                "exactSignTestP": round(exact_sign_test(only_base, only_ft), 6),
                "differenceFinetunedMinusBasePoints": round(diff_pts, 2),
                "baseWilsonWidthPoints": round((base_p["wilson95"][1] - base_p["wilson95"][0]) * 100, 2),
                "finetunedWilsonWidthPoints": round((ft_p["wilson95"][1] - ft_p["wilson95"][0]) * 100, 2),
                "differenceExceedsEitherIntervalWidth": abs(diff_pts)
                > max(
                    (base_p["wilson95"][1] - base_p["wilson95"][0]) * 100,
                    (ft_p["wilson95"][1] - ft_p["wilson95"][0]) * 100,
                ),
            },
        }

    with open(args.commands) as fh:
        commands = [line.rstrip("\n") for line in fh if line.strip()]

    report = {
        "title": "Held-out TEST split: base vs fix-diagnostic LoRA, MLX inference",
        "date": args.date,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runtime": {
            "inference": "MLX (mlx_lm 0.32.2), NOT the product runtime (ggml-node). The fine-tuned GGUF was not produced: "
            "llama.cpp was not approved, so ggml-node cannot load the adapter. MLX output is unconstrained (no grammar), "
            "while the product runtime constrains output to the JSON schema.",
            "base": "Qwen/Qwen2.5-1.5B-Instruct, native weights (bfloat16 as stored; not cast to fp16)",
            "finetuned": "same base + LoRA adapter training/runs/fix-diagnostic/adapters (rank 8, scale 20, 300 iters)",
            "decoding": "temperature 0.2, seed 0, max_tokens 768, one candidate (maxCandidates 1)",
            "chatTemplate": "one user message = the engine prompt, add_generation_prompt=True (same as mlx_lm lora training)",
        },
        "protocol": {
            "testTasks": len(prompts),
            "kinds": kinds,
            "compilerResolvedExcluded": len(compiler_ids),
            "compilerNote": "Tasks fixed by the compiler quick fix never call the model. They are excluded from the model "
            "comparison and counted for both models equally.",
            "modelComparisonSampleSize": len(model_ids),
            "parseModes": {
                "strict": "headline per protocol: the completion must be bare JSON",
                "fence-stripped": "sensitivity: one surrounding ```json fence is removed before JSON.parse. "
                "Base wraps every output in a fence, so strict scoring measures the wrapper, not the edit.",
            },
        },
        "results": parses,
        "commands": commands,
    }
    out = os.path.join(ROOT, "training", "reports", f"mlx-test-{args.date}.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    for parse, r in parses.items():
        b = r["models"]["base"]["modelComparison"]
        f = r["models"]["finetuned"]["modelComparison"]
        pr = r["pairedModelComparison"]
        print(
            f"[{parse}] base {b['passed']}/{b['total']} {b['wilson95']} | ft {f['passed']}/{f['total']} {f['wilson95']} "
            f"| diff {pr['differenceFinetunedMinusBasePoints']} pts | only-base {pr['onlyBasePassed']} only-ft "
            f"{pr['onlyFinetunedPassed']} p={pr['exactSignTestP']} | exceeds width: {pr['differenceExceedsEitherIntervalWidth']}"
        )
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
