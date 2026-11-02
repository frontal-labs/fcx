"""Merges collection stats, training losses and the held-out evaluations into training/reports/<date>.json.

Reads: training/data/fix-diagnostic/stats.json, training/runs/fix-diagnostic/train.log,
       training/reports/base-test-<date>.json and (when present) training/reports/finetuned-test-<date>.json.
Prints a short summary. The report never marks the model as shipped: that decision is made by a person after reading it.
Usage: python3 training/report.py --date 2026-11-02
"""

import argparse
import json
import math
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path):
    if not os.path.exists(path):
        return None
    with open(path) as fh:
        return json.load(fh)


def exact_sign_test(b, c):
    """Two-sided exact binomial (sign) test on discordant pairs. b and c are the two discordant counts."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(0, k + 1)) / (2 ** n)
    return min(1.0, 2 * tail)


def wilson(passed, total, z=1.96):
    if total == 0:
        return (0.0, 0.0)
    p = passed / total
    denom = 1 + z * z / total
    centre = (p + z * z / (2 * total)) / denom
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denom
    return (round(centre - half, 4), round(centre + half, 4))


def train_curve(path):
    if not os.path.exists(path):
        return {}
    train, val = {}, {}
    with open(path, errors="replace") as fh:
        for line in fh:
            m = re.search(r"Iter (\d+): Train loss ([\d.]+)", line)
            if m:
                train[int(m.group(1))] = float(m.group(2))
            m = re.search(r"Iter (\d+): Val loss ([\d.]+)", line)
            if m:
                val[int(m.group(1))] = float(m.group(2))
    last_train = max(train) if train else None
    last_val = max(val) if val else None
    return {
        "trainLossFirst": train.get(min(train)) if train else None,
        "trainLossLast": train.get(last_train) if last_train is not None else None,
        "valLoss": {str(k): v for k, v in sorted(val.items())},
        "lastValLoss": val.get(last_val) if last_val is not None else None,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", required=True)
    args = parser.parse_args()
    d = args.date

    stats = load(os.path.join(ROOT, "training", "data", "fix-diagnostic", "stats.json")) or {}
    base = load(os.path.join(ROOT, "training", "reports", f"base-test-{d}.json"))
    ft = load(os.path.join(ROOT, "training", "reports", f"finetuned-test-{d}.json"))

    def strip(ev):
        if ev is None:
            return None
        return {k: v for k, v in ev.items() if k != "results"}

    report = {
        "date": d,
        "base": {"model": "Qwen/Qwen2.5-1.5B-Instruct (Apache-2.0) via ggml/auto qwen2.5-1.5b-instruct-q4_k_m"},
        "data": {
            "splits": {
                name: {
                    "tasks": info.get("tasks"),
                    "examples": info.get("examples"),
                    "perCategory": info.get("perCategory"),
                    "failures": info.get("failures"),
                    "duplicatesRemoved": info.get("duplicatesRemoved"),
                    "capture": info.get("capture"),
                }
                for name, info in stats.get("splits", {}).items()
            }
        },
        "training": {
            "config": "training/configs/fix-diagnostic.yaml",
            **train_curve(os.path.join(ROOT, "training", "runs", "fix-diagnostic", "train.log")),
        },
        "heldOutTest": {"base": strip(base), "finetuned": strip(ft)},
    }

    lines = []
    if base:
        n = base["total"]
        lo, hi = wilson(base["passed"], n)
        lines.append(f"base on test: {base['passed']}/{n} ({base['passRate']:.1%}, 95% Wilson {lo:.1%}-{hi:.1%}), "
                     f"median {base['medianMs']} ms")
    if base and ft:
        bp = {r["id"]: r["pass"] for r in base["results"]}
        fp = {r["id"]: r["pass"] for r in ft["results"]}
        common = [k for k in bp if k in fp]
        only_base = sum(1 for k in common if bp[k] and not fp[k])
        only_ft = sum(1 for k in common if fp[k] and not bp[k])
        p = exact_sign_test(only_ft, only_base)
        lo, hi = wilson(ft["passed"], ft["total"])
        lines.append(f"finetuned on test: {ft['passed']}/{ft['total']} ({ft['passRate']:.1%}, 95% Wilson "
                     f"{lo:.1%}-{hi:.1%}), median {ft['medianMs']} ms")
        lines.append(f"paired on {len(common)} tasks: finetuned-only passes {only_ft}, base-only passes {only_base}, "
                     f"exact sign test p={p:.3f}")
        report["heldOutTest"]["paired"] = {
            "tasks": len(common),
            "finetunedOnly": only_ft,
            "baseOnly": only_base,
            "signTestP": round(p, 4),
        }
        report["heldOutTest"]["finetunedBetter"] = ft["passed"] > base["passed"]
    elif base:
        lines.append("finetuned: not evaluated (GGUF export did not run). Only the base result is measured.")
    report["summary"] = lines
    report["shipped"] = False

    out = os.path.join(ROOT, "training", "reports", f"{d}.json")
    with open(out, "w") as fh:
        json.dump(report, fh, indent=2)
        fh.write("\n")
    for line in lines:
        print(line)
    print(f"report: {out}")


if __name__ == "__main__":
    main()
