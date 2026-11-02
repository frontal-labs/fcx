/**
 * Step 1 of the MLX held-out comparison. For every TEST task, runs the real fix command (the same code path as
 * evals/run.ts and collect.ts) with one candidate. The model is a capture stub: it records the first prompt the
 * recipe sends and returns an output that does not match the schema, so nothing is generated and nothing is applied.
 *
 * A task whose first candidate is resolved by the compiler quick fix never calls the model. Those are written with
 * kind "compiler" and are excluded from the model comparison (they are counted for both models equally).
 *
 * Usage: bun training/src/capture-test-prompts.ts [--out training/eval-mlx/test-prompts.jsonl]
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type FixReport, runFixCommand } from "../../cli/src/commands/fix.ts";
import { createTsChecker, errorsOnly } from "../../packages/verify/src/index.ts";
import { type Task, loadTasks, materialize, tasksRoot } from "./pipeline.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const repoRoot = resolve(tasksRoot(), "..", "..");
const outFile = resolve(
  flag("--out") ?? join(repoRoot, "training", "eval-mlx", "test-prompts.jsonl"),
);

type Kind = "model" | "compiler" | "other";

interface Row {
  id: string;
  split: string;
  category: string;
  family: string | undefined;
  kind: Kind;
  /** The exact string the engine sends as the first model prompt (kind "model" only). */
  prompt: string | undefined;
  /** The first-candidate status from the capture run, for audit. */
  captureStatus: FixReport["status"] | "error";
  /** Criterion inputs: the same files and target that evals/run.ts materializes and grades. */
  criterion: {
    files: Record<string, string>;
    target: string;
    check: "no-type-errors-in-target-file";
  };
}

const tasks: Task[] = loadTasks(join(tasksRoot(), "test"));
const rows: Row[] = [];

for (const task of tasks) {
  const workspace = materialize(task);
  const prompts: string[] = [];
  const stub = {
    generateObject: async (req: { prompt: string }) => {
      prompts.push(req.prompt);
      // Invalid on purpose: it does not match the schema, so no edit can be produced or applied.
      return { object: {}, ms: 0, raw: "{}" };
    },
  };
  const targetRel = task.target.split(":")[0] as string;
  let row: Row;
  try {
    const report = await runFixCommand({
      workspace,
      target: task.target,
      permissionMode: "workspace-write",
      dryRun: false,
      maxCandidates: 1,
      model: stub as never,
      approve: async () => false,
      undoRoot: join(workspace, ".undo"),
      logsDir: join(workspace, ".logs"),
    });
    const checker = createTsChecker(workspace, join(workspace, targetRel));
    const remaining = errorsOnly(checker.diagnostics(join(workspace, targetRel))).length;
    checker.dispose();
    let kind: Kind = "other";
    if (prompts.length > 0) kind = "model";
    else if (report.status === "applied" && remaining === 0) kind = "compiler";
    row = {
      id: task.id,
      split: task.split,
      category: task.category,
      family: task.family,
      kind,
      prompt: kind === "model" ? prompts[0] : undefined,
      captureStatus: report.status,
      criterion: { files: task.files, target: task.target, check: "no-type-errors-in-target-file" },
    };
  } catch (error) {
    row = {
      id: task.id,
      split: task.split,
      category: task.category,
      family: task.family,
      kind: prompts.length > 0 ? "model" : "other",
      prompt: prompts.length > 0 ? prompts[0] : undefined,
      captureStatus: "error",
      criterion: { files: task.files, target: task.target, check: "no-type-errors-in-target-file" },
    };
    console.error(
      `${task.id}: capture error ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
  rows.push(row);
  console.log(`${row.id}: ${row.kind} (${row.captureStatus})`);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
const count = (k: Kind) => rows.filter((r) => r.kind === k).length;
console.log(
  `\ntest tasks: ${rows.length}  model prompts: ${count("model")}  compiler: ${count("compiler")}  other: ${count("other")}`,
);
console.log(`Wrote ${outFile}`);
