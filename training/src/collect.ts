/**
 * Collects fix-diagnostic training examples from the CURRENT local model (ggml/auto) on the train and validation
 * splits. The test split is never read here.
 *
 * A task yields one example only when the accepted candidate passed every layer and the file has no type errors.
 *   - model candidate: prompt = the exact string the engine sent, completion = the model's own output for that call.
 *   - compiler quick fix: prompt = the prompt the model would receive for this task (see capturePrompt), completion =
 *     the compiler's edits in the recipe's JSON shape.
 *
 * Usage: bun training/src/collect.ts [--out training/data/fix-diagnostic] [--filter <id substring>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GgmlNodeModelHost } from "../../packages/model/src/index.ts";
import {
  type Edit,
  type RecordedCall,
  type Task,
  type TaskOutcome,
  capturePrompt,
  loadTasks,
  runTask,
  tasksRoot,
} from "./pipeline.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const repoRoot = resolve(tasksRoot(), "..", "..");
const outDir = resolve(flag("--out") ?? join(repoRoot, "training", "data", "fix-diagnostic"));

// Split name on disk -> output file name. The test split is deliberately absent.
const SPLITS: Array<{ dir: string; file: string }> = [
  { dir: "train", file: "train.jsonl" },
  { dir: "validation", file: "valid.jsonl" },
];

interface Example {
  prompt: string;
  completion: string;
}

const completionOf = (edits: Edit[]): string =>
  JSON.stringify({
    edits: edits.map((e) => ({ file: e.file, search: e.search, replace: e.replace })),
  });

const normalize = (prompt: string): string => prompt.replace(/\s+/g, " ").trim();

const model = new GgmlNodeModelHost({});
const stats: Record<string, unknown> = { generatedAt: new Date().toISOString(), splits: {} };
mkdirSync(outDir, { recursive: true });

for (const split of SPLITS) {
  const filter = flag("--filter") ?? "";
  const tasks: Task[] = loadTasks(join(tasksRoot(), split.dir)).filter((t) =>
    t.id.includes(filter),
  );
  const examples: Example[] = [];
  const seen = new Set<string>();
  const perCategory: Record<
    string,
    { tasks: number; passed: number; kept: number; compiler: number; model: number }
  > = {};
  const failures: Record<string, number> = {};
  let captureChecked = 0;
  let captureMatched = 0;
  let duplicates = 0;

  for (const task of tasks) {
    const bucket = perCategory[task.category] ?? {
      tasks: 0,
      passed: 0,
      kept: 0,
      compiler: 0,
      model: 0,
    };
    perCategory[task.category] = bucket;
    bucket.tasks += 1;
    const outcome: TaskOutcome = await runTask(task, model);
    if (!outcome.pass) {
      const key = outcome.error ? `${outcome.status}: ${outcome.error}` : outcome.status;
      failures[key] = (failures[key] ?? 0) + 1;
      continue;
    }
    bucket.passed += 1;

    let prompt: string | undefined;
    let completion: string | undefined;
    if (outcome.candidateSource === "model" && outcome.acceptedModelCallIndex !== undefined) {
      const call: RecordedCall | undefined = outcome.calls[outcome.acceptedModelCallIndex];
      if (!call) {
        failures["passed-without-recorded-call"] =
          (failures["passed-without-recorded-call"] ?? 0) + 1;
        continue;
      }
      prompt = call.prompt;
      completion = completionOf(call.edits);
      bucket.model += 1;
      if (outcome.acceptedModelCallIndex === 0) {
        // Check that the capture path reproduces the runtime prompt on this task.
        const captured = await capturePrompt(task);
        captureChecked += 1;
        if (captured === prompt) captureMatched += 1;
      }
    } else if (outcome.candidateSource === "compiler" && outcome.acceptedEdits) {
      prompt = await capturePrompt(task);
      completion = completionOf(outcome.acceptedEdits);
      bucket.compiler += 1;
    }
    if (!prompt || !completion) {
      failures["passed-without-example"] = (failures["passed-without-example"] ?? 0) + 1;
      continue;
    }

    const key = normalize(prompt);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    examples.push({ prompt, completion });
    bucket.kept += 1;
  }

  writeFileSync(join(outDir, split.file), `${examples.map((e) => JSON.stringify(e)).join("\n")}\n`);
  (stats.splits as Record<string, unknown>)[split.dir] = {
    file: split.file,
    tasks: tasks.length,
    examples: examples.length,
    duplicatesRemoved: duplicates,
    perCategory,
    failures,
    capture: { checked: captureChecked, matchedRuntimePrompt: captureMatched },
  };
  console.log(`${split.dir}: ${examples.length} examples from ${tasks.length} tasks`);
}

writeFileSync(join(outDir, "stats.json"), `${JSON.stringify(stats, null, 2)}\n`);
await model.shutdown();
