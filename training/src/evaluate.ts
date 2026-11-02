/**
 * Evaluates one model on a task split with the same metric as evals/run.ts: a task passes when the fix was applied
 * and the target file has no type errors afterwards.
 *
 * Usage: bun training/src/evaluate.ts --model base|<path to .gguf> --label <name> --out <file>
 *        [--split test] [--filter <id substring>] [--limit <n>]
 * Writes one JSON report with per-category pass counts, latency, and candidates used.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GgmlNodeModelHost } from "../../packages/model/src/index.ts";
import { PathModelHost } from "./path-host.ts";
import { type TaskOutcome, loadTasks, median, runTask, tasksRoot } from "./pipeline.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const modelArg = flag("--model") ?? "base";
const label = flag("--label") ?? (modelArg === "base" ? "base" : "finetuned");
const split = flag("--split") ?? "test";
const filter = flag("--filter") ?? "";
const limit = Number.parseInt(flag("--limit") ?? "0", 10);
const outFile = resolve(
  flag("--out") ?? join(tasksRoot(), "..", "reports", `${label}-${split}.json`),
);

const tasks = loadTasks(join(tasksRoot(), split))
  .filter((t) => t.id.includes(filter))
  .slice(0, limit > 0 ? limit : undefined);

// The base model is the registry's ggml/auto. Anything else is a GGUF file path.
const model =
  modelArg === "base" ? new GgmlNodeModelHost({}) : new PathModelHost(resolve(modelArg));
const modelName =
  modelArg === "base" ? "ggml/auto (qwen2.5-1.5b-instruct-q4_k_m)" : resolve(modelArg);

const results: TaskOutcome[] = [];
for (const task of tasks) {
  const outcome = await runTask(task, model);
  results.push(outcome);
  console.log(
    `${outcome.id}: ${outcome.status} pass=${outcome.pass} source=${outcome.candidateSource ?? "-"} ` +
      `candidates=${outcome.candidates} ${outcome.totalMs}ms`,
  );
}
await model.shutdown();

const passed = results.filter((r) => r.pass).length;
const categories = [...new Set(results.map((r) => r.category))].sort();
const byCategory = Object.fromEntries(
  categories.map((c) => {
    const rs = results.filter((r) => r.category === c);
    return [c, { passed: rs.filter((r) => r.pass).length, total: rs.length }];
  }),
);
const latencies = results.map((r) => r.totalMs);
const sortedLatencies = [...latencies].sort((a, b) => a - b);
const summary = {
  label,
  model: modelName,
  split,
  generatedAt: new Date().toISOString(),
  total: results.length,
  passed,
  passRate: results.length === 0 ? 0 : passed / results.length,
  byCategory,
  medianMs: median(latencies),
  p90Ms:
    sortedLatencies[
      Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.9))
    ] ?? 0,
  candidates: {
    mean: results.length === 0 ? 0 : results.reduce((s, r) => s + r.candidates, 0) / results.length,
    median: median(results.map((r) => r.candidates)),
    acceptedFromCompiler: results.filter((r) => r.pass && r.candidateSource === "compiler").length,
    acceptedFromModel: results.filter((r) => r.pass && r.candidateSource === "model").length,
  },
  results: results.map(({ calls: _calls, acceptedEdits: _edits, ...rest }) => rest),
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n${label} on ${split}: ${passed}/${results.length} passed. Report: ${outFile}`);
